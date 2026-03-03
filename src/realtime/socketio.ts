import { Server as HTTPServer, IncomingMessage } from "http";
import { Server as IOServer, Socket } from "socket.io";
import { verifyToken } from "../middleware/auth.ts";
import { db, schema } from "../db/index.ts";
import { eq } from "drizzle-orm";

type SocketUser = {
  userId: string;
  username: string;
};

export class RealtimeServer {
  private io: IOServer | null = null;
  private userSocketCount = new Map<string, number>();
  // roomId -> userId -> timer
  private typingTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  attach(server: HTTPServer) {
    this.io = new IOServer(server, {
      path: "/socket.io",
      cors: { origin: true, credentials: true },
    });

    this.io.use((socket, next) => {
      const token = (socket.handshake.auth?.token as string | undefined)
        || (socket.handshake.query?.token as string | undefined)
        || this.extractBearer(socket.request);

      if (!token) return next(new Error("Missing token"));

      try {
        const payload = verifyToken(token) as { userId: string; username: string };
        socket.data.user = { userId: payload.userId, username: payload.username } satisfies SocketUser;
        return next();
      } catch {
        return next(new Error("Invalid token"));
      }
    });

    this.io.on("connection", (socket) => {
      void this.handleConnection(socket);
    });
  }

  private extractBearer(req: IncomingMessage): string | undefined {
    const auth = req.headers.authorization;
    if (!auth) return undefined;
    const [kind, token] = auth.split(" ");
    if (kind?.toLowerCase() !== "bearer") return undefined;
    return token;
  }

  private async handleConnection(socket: Socket) {
    const user = socket.data.user as SocketUser | undefined;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    const userRoom = this.userRoom(user.userId);
    socket.join(userRoom);

    this.userSocketCount.set(user.userId, (this.userSocketCount.get(user.userId) || 0) + 1);

    await db
      .update(schema.users)
      .set({ isOnline: true, lastSeen: new Date() })
      .where(eq(schema.users.id, user.userId));

    await this.joinUserRooms(socket, user.userId);
    await this.broadcastPresence(user.userId, true);

    socket.emit("connected", { userId: user.userId });

    socket.on("typing:start", (payload: any) => {
      this.handleTypingStart(socket, payload?.roomId);
    });

    socket.on("typing:stop", (payload: any) => {
      this.handleTypingStop(socket, payload?.roomId);
    });

    socket.on("room:join", (payload: any) => {
      if (payload?.roomId) socket.join(payload.roomId);
    });

    socket.on("room:leave", (payload: any) => {
      if (payload?.roomId) socket.leave(payload.roomId);
    });

    socket.on("ping", () => {
      socket.emit("pong", { ts: Date.now() });
    });

    socket.on("disconnect", () => {
      void this.handleDisconnect(socket);
    });
  }

  private async joinUserRooms(socket: Socket, userId: string) {
    const memberships = await db.query.roomMembers.findMany({
      where: eq(schema.roomMembers.userId, userId),
      columns: { roomId: true },
    });
    for (const m of memberships) socket.join(m.roomId);
  }

  private handleTypingStart(socket: Socket, roomId?: string) {
    if (!this.io || !roomId) return;
    const user = socket.data.user as SocketUser | undefined;
    if (!user) return;

    const roomTimers = this.typingTimers.get(roomId) || new Map();
    const prev = roomTimers.get(user.userId);
    if (prev) clearTimeout(prev);

    this.io.to(roomId).except(this.userRoom(user.userId)).emit("typing:start", {
      userId: user.userId,
      username: user.username,
      roomId,
    });

    const timer = setTimeout(() => {
      this.handleTypingStop(socket, roomId);
    }, 3000);

    roomTimers.set(user.userId, timer);
    this.typingTimers.set(roomId, roomTimers);
  }

  private handleTypingStop(socket: Socket, roomId?: string) {
    if (!this.io || !roomId) return;
    const user = socket.data.user as SocketUser | undefined;
    if (!user) return;

    const roomTimers = this.typingTimers.get(roomId);
    const prev = roomTimers?.get(user.userId);
    if (prev) clearTimeout(prev);
    roomTimers?.delete(user.userId);

    this.io.to(roomId).except(this.userRoom(user.userId)).emit("typing:stop", {
      userId: user.userId,
      roomId,
    });
  }

  private async handleDisconnect(socket: Socket) {
    const user = socket.data.user as SocketUser | undefined;
    if (!user) return;

    for (const roomId of socket.rooms) {
      if (roomId !== socket.id && !roomId.startsWith("user:")) {
        this.handleTypingStop(socket, roomId);
      }
    }

    const nextCount = Math.max(0, (this.userSocketCount.get(user.userId) || 1) - 1);
    if (nextCount === 0) {
      this.userSocketCount.delete(user.userId);
      await db
        .update(schema.users)
        .set({ isOnline: false, lastSeen: new Date() })
        .where(eq(schema.users.id, user.userId));
      await this.broadcastPresence(user.userId, false);
    } else {
      this.userSocketCount.set(user.userId, nextCount);
    }
  }

  broadcastToRoom(roomId: string, data: any, excludeUserId?: string) {
    if (!this.io) return;
    const emitter = this.io.to(roomId);
    if (excludeUserId) {
      emitter.except(this.userRoom(excludeUserId)).emit(data.type, data.payload);
      return;
    }
    emitter.emit(data.type, data.payload);
  }

  broadcastToUser(userId: string, data: any) {
    if (!this.io) return;
    this.io.to(this.userRoom(userId)).emit(data.type, data.payload);
  }

  stopTypingForUser(roomId: string, userId: string) {
    if (!this.io) return;

    const roomTimers = this.typingTimers.get(roomId);
    const prev = roomTimers?.get(userId);
    if (prev) clearTimeout(prev);
    roomTimers?.delete(userId);

    this.io.to(roomId).except(this.userRoom(userId)).emit("typing:stop", {
      userId,
      roomId,
    });
  }

  private async broadcastPresence(userId: string, isOnline: boolean) {
    if (!this.io) return;
    const memberships = await db.query.roomMembers.findMany({
      where: eq(schema.roomMembers.userId, userId),
      columns: { roomId: true },
    });
    for (const m of memberships) {
      this.io.to(m.roomId).emit("presence", {
        userId,
        isOnline,
        lastSeen: new Date().toISOString(),
      });
    }
  }

  getOnlineUsersInRoom(roomId: string): string[] {
    if (!this.io) return [];
    const room = this.io.sockets.adapter.rooms.get(roomId);
    if (!room) return [];

    const ids = new Set<string>();
    for (const socketId of room) {
      const socket = this.io.sockets.sockets.get(socketId);
      const user = socket?.data?.user as SocketUser | undefined;
      if (user?.userId) ids.add(user.userId);
    }
    return [...ids];
  }

  private userRoom(userId: string) {
    return `user:${userId}`;
  }
}
