import { WebSocketServer as WS, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { verifyToken } from "../middleware/auth.ts";
import { db, schema } from "../db/index.ts";
import { eq, and } from "drizzle-orm";

interface AuthenticatedClient {
  ws: WebSocket;
  userId: string;
  username: string;
  rooms: Set<string>;
}

export class WebSocketServer {
  private wss: WS;
  // userId -> Set of clients (one user can have multiple tabs)
  private userClients = new Map<string, Set<AuthenticatedClient>>();
  // roomId -> Set of clients
  private roomClients = new Map<string, Set<AuthenticatedClient>>();
  // Typing: roomId -> Map<userId, timeout>
  private typingTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  constructor() {
    this.wss = new WS({ noServer: true });
    this.wss.on("connection", this.handleConnection.bind(this));
  }

  get server() {
    return this.wss;
  }

  handleUpgrade(req: IncomingMessage, socket: any, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage) {
    // Extract token from query string: ?token=...
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      ws.send(JSON.stringify({ type: "error", payload: "Missing token" }));
      ws.close(1008, "Missing token");
      return;
    }

    let payload: { userId: string; username: string };
    try {
      payload = verifyToken(token) as { userId: string; username: string };
    } catch {
      ws.send(JSON.stringify({ type: "error", payload: "Invalid token" }));
      ws.close(1008, "Invalid token");
      return;
    }

    const client: AuthenticatedClient = {
      ws,
      userId: payload.userId,
      username: payload.username,
      rooms: new Set(),
    };

    // Register client
    if (!this.userClients.has(client.userId)) {
      this.userClients.set(client.userId, new Set());
    }
    this.userClients.get(client.userId)!.add(client);

    // Update online status
    db.update(schema.users)
      .set({ isOnline: true, lastSeen: new Date() })
      .where(eq(schema.users.id, client.userId))
      .then(() => {
        // Notify presence to all connected users in shared rooms
        this.broadcastPresence(client.userId, true);
      });

    // Auto-join all the user's rooms
    this.joinUserRooms(client);

    ws.send(JSON.stringify({ type: "connected", payload: { userId: client.userId } }));

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(client, msg);
      } catch {
        ws.send(JSON.stringify({ type: "error", payload: "Invalid JSON" }));
      }
    });

    ws.on("close", () => {
      this.handleDisconnect(client);
    });

    ws.on("error", (err) => {
      console.error(`WS error for ${client.username}:`, err.message);
    });
  }

  private async joinUserRooms(client: AuthenticatedClient) {
    const memberships = await db.query.roomMembers.findMany({
      where: eq(schema.roomMembers.userId, client.userId),
      columns: { roomId: true },
    });

    for (const m of memberships) {
      this.joinRoom(client, m.roomId);
    }
  }

  joinRoom(client: AuthenticatedClient, roomId: string) {
    client.rooms.add(roomId);
    if (!this.roomClients.has(roomId)) {
      this.roomClients.set(roomId, new Set());
    }
    this.roomClients.get(roomId)!.add(client);
  }

  leaveRoom(client: AuthenticatedClient, roomId: string) {
    client.rooms.delete(roomId);
    this.roomClients.get(roomId)?.delete(client);
  }

  private handleMessage(client: AuthenticatedClient, msg: any) {
    switch (msg.type) {
      case "typing:start":
        this.handleTypingStart(client, msg.payload?.roomId);
        break;
      case "typing:stop":
        this.handleTypingStop(client, msg.payload?.roomId);
        break;
      case "room:join":
        if (msg.payload?.roomId) this.joinRoom(client, msg.payload.roomId);
        break;
      case "room:leave":
        if (msg.payload?.roomId) this.leaveRoom(client, msg.payload.roomId);
        break;
      case "ping":
        client.ws.send(JSON.stringify({ type: "pong" }));
        break;
      default:
        client.ws.send(JSON.stringify({ type: "error", payload: `Unknown message type: ${msg.type}` }));
    }
  }

  private handleTypingStart(client: AuthenticatedClient, roomId: string) {
    if (!roomId) return;

    // Clear existing timer
    const roomTimers = this.typingTimers.get(roomId) || new Map();
    if (roomTimers.has(client.userId)) {
      clearTimeout(roomTimers.get(client.userId)!);
    }

    // Broadcast typing indicator to room (excluding sender)
    this.broadcastToRoom(
      roomId,
      {
        type: "typing:start",
        payload: {
          userId: client.userId,
          username: client.username,
          roomId,
        },
      },
      client.userId
    );

    // Auto-stop after 3s
    const timer = setTimeout(() => {
      this.handleTypingStop(client, roomId);
    }, 3000);

    roomTimers.set(client.userId, timer);
    this.typingTimers.set(roomId, roomTimers);
  }

  private handleTypingStop(client: AuthenticatedClient, roomId: string) {
    if (!roomId) return;

    const roomTimers = this.typingTimers.get(roomId);
    if (roomTimers?.has(client.userId)) {
      clearTimeout(roomTimers.get(client.userId)!);
      roomTimers.delete(client.userId);
    }

    this.broadcastToRoom(
      roomId,
      {
        type: "typing:stop",
        payload: { userId: client.userId, roomId },
      },
      client.userId
    );
  }

  private handleDisconnect(client: AuthenticatedClient) {
    // Remove from all rooms
    for (const roomId of client.rooms) {
      this.roomClients.get(roomId)?.delete(client);
      this.handleTypingStop(client, roomId);
    }

    // Remove from user clients
    const userSet = this.userClients.get(client.userId);
    userSet?.delete(client);

    // If no more connections for this user, mark offline
    if (!userSet || userSet.size === 0) {
      this.userClients.delete(client.userId);
      db.update(schema.users)
        .set({ isOnline: false, lastSeen: new Date() })
        .where(eq(schema.users.id, client.userId))
        .then(() => {
          this.broadcastPresence(client.userId, false);
        });
    }
  }

  broadcastToRoom(roomId: string, data: any, excludeUserId?: string) {
    const clients = this.roomClients.get(roomId);
    if (!clients) return;

    const json = JSON.stringify(data);
    for (const client of clients) {
      if (excludeUserId && client.userId === excludeUserId) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(json);
      }
    }
  }

  broadcastToUser(userId: string, data: any) {
    const clients = this.userClients.get(userId);
    if (!clients) return;
    const json = JSON.stringify(data);
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(json);
      }
    }
  }

  private broadcastPresence(userId: string, isOnline: boolean) {
    // Find all rooms this user is in and notify members
    db.query.roomMembers
      .findMany({
        where: eq(schema.roomMembers.userId, userId),
        columns: { roomId: true },
      })
      .then((memberships) => {
        const notified = new Set<string>();
        for (const m of memberships) {
          const clients = this.roomClients.get(m.roomId);
          if (!clients) continue;
          for (const client of clients) {
            if (!notified.has(client.userId) && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(
                JSON.stringify({
                  type: "presence",
                  payload: { userId, isOnline, lastSeen: new Date().toISOString() },
                })
              );
              notified.add(client.userId);
            }
          }
        }
      });
  }

  getOnlineUsersInRoom(roomId: string): string[] {
    const clients = this.roomClients.get(roomId);
    if (!clients) return [];
    return [...new Set([...clients].map((c) => c.userId))];
  }
}
