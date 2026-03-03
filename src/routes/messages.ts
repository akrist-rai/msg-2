import Router from "@koa/router";
import { z } from "zod";
import { eq, and, lt, desc, isNull, sql, inArray } from "drizzle-orm";
import { db, schema, supabase } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { WebSocketServer } from "../ws/handler.ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// ─── Helper: check room membership ───────────────────────────────────────────

async function assertMember(roomId: string, userId: string) {
  return db.query.roomMembers.findFirst({
    where: and(
      eq(schema.roomMembers.roomId, roomId),
      eq(schema.roomMembers.userId, userId)
    ),
  });
}

// ─── Validation ───────────────────────────────────────────────────────────────

const sendMessageSchema = z.object({
  content: z.string().max(4000).optional().default(""),
  type: z.enum(["text", "image"]).default("text"),
  replyToId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional().default([]),
});

function inferAttachmentType(mimeType: string): "image" | "video" | "audio" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

function getFirstFile(files: any): any | null {
  if (!files) return null;
  const candidates = [files.file, files.attachment, files.upload];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) return candidate[0] ?? null;
    return candidate;
  }
  const first = Object.values(files)[0];
  if (!first) return null;
  return Array.isArray(first) ? first[0] ?? null : first;
}

function safeExt(filename: string): string {
  const ext = path.extname(filename || "").toLowerCase();
  return /^[a-z0-9.]{0,12}$/.test(ext) ? ext : "";
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createMessagesRouter(wss?: WebSocketServer) {
  const router = new Router({ prefix: "/rooms/:roomId/messages" });

  // ─── GET /poll (REDIRECT TO WEBSOCKET) ─────────────────────────────────────
  
  router.get("/poll", requireAuth, async (ctx) => {
    const { roomId } = ctx.params;
    const token = ctx.headers.authorization?.split(' ')[1];
    const wsProtocol = ctx.protocol === "https" ? "wss" : "ws";
    
    // Check if user is a member
    const membership = await assertMember(roomId, ctx.state.userId);
    if (!membership) {
      ctx.status = 403;
      ctx.body = { error: "Not a member of this room" };
      return;
    }

    // Return 426 Upgrade Required with WebSocket connection info
    ctx.status = 426;
    ctx.set('Upgrade', 'websocket');
    ctx.body = {
      error: "Long polling is not supported. Please use WebSocket for real-time messages.",
      upgrade: {
        protocol: "websocket",
        url: `${wsProtocol}://${ctx.host}/ws?token=${token}`,
        documentation: "/docs/websocket",
        events: [
          "message:new",
          "message:edited",
          "message:deleted",
          "message:reaction",
          "typing:start",
          "typing:stop"
        ],
        example: {
          javascript: `
	const ws = new WebSocket('${wsProtocol}://${ctx.host}/ws?token=${token}');
ws.onmessage = (event) => {
  const { type, payload } = JSON.parse(event.data);
  if (type === 'message:new' && payload.roomId === '${roomId}') {
    console.log('New message:', payload);
  }
};
          `.trim()
        }
      }
    };
  });

  // ─── GET /stream (REDIRECT TO WEBSOCKET) ───────────────────────────────────
  
  router.get("/stream", requireAuth, async (ctx) => {
    const { roomId } = ctx.params;
    const token = ctx.headers.authorization?.split(' ')[1];
    const wsProtocol = ctx.protocol === "https" ? "wss" : "ws";
    
    const membership = await assertMember(roomId, ctx.state.userId);
    if (!membership) {
      ctx.status = 403;
      ctx.body = { error: "Not a member of this room" };
      return;
    }

    ctx.status = 426;
    ctx.set('Upgrade', 'websocket');
    ctx.body = {
      error: "Server-Sent Events are not supported. Use WebSocket.",
      upgrade: {
        protocol: "websocket",
        url: `${wsProtocol}://${ctx.host}/ws?token=${token}`,
        roomId: roomId
      }
    };
  });

  // ─── POST /attachments  (upload file and create pending attachment) ─────────

  router.post("/attachments", requireAuth, async (ctx) => {
    const { roomId } = ctx.params;
    const membership = await assertMember(roomId, ctx.state.userId);
    if (!membership) {
      ctx.status = 403;
      ctx.body = { error: "Not a member of this room" };
      return;
    }

    const file = getFirstFile((ctx.request as any).files);
    if (!file?.filepath) {
      ctx.status = 400;
      ctx.body = { error: "No file uploaded" };
      return;
    }

    const mimeType = file.mimetype || "application/octet-stream";
    const filename = file.originalFilename || file.newFilename || "upload.bin";
    const attachmentType = inferAttachmentType(mimeType);
    const extension = safeExt(filename);
    const objectName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
    let storagePath = `${ctx.state.userId}/${objectName}`;

    const fileBytes = await Bun.file(file.filepath).arrayBuffer();
    let publicUrl = "";

    if (supabase) {
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || "attachments";

      let uploadResult = await supabase.storage
        .from(bucket)
        .upload(storagePath, fileBytes, { contentType: mimeType, upsert: false });

      if (uploadResult.error && /bucket not found/i.test(uploadResult.error.message)) {
        await supabase.storage.createBucket(bucket, { public: true });
        uploadResult = await supabase.storage
          .from(bucket)
          .upload(storagePath, fileBytes, { contentType: mimeType, upsert: false });
      }

      if (uploadResult.error) {
        ctx.status = 500;
        ctx.body = { error: `Upload failed: ${uploadResult.error.message}` };
        return;
      }

      const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
      publicUrl = publicData.publicUrl;
    } else {
      // Neon-only setup fallback: store attachments on local disk under /public/uploads.
      const relativePath = path.posix.join("uploads", ctx.state.userId, objectName);
      const absolutePath = path.join(process.cwd(), "public", ...relativePath.split("/"));
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await Bun.write(absolutePath, fileBytes);
      storagePath = relativePath;
      publicUrl = `${ctx.origin}/${relativePath}`;
    }

    const [attachment] = await db
      .insert(schema.attachments)
      .values({
        messageId: null,
        uploaderId: ctx.state.userId,
        attachmentType,
        storagePath,
        publicUrl,
        filename,
        mimeType,
        size: Number(file.size || fileBytes.byteLength),
      })
      .returning();

    ctx.status = 201;
    ctx.body = { attachment };
  });

  // ─── GET /  (cursor-based pagination) ──────────────────────────────────────

  router.get("/", requireAuth, async (ctx) => {
    const { roomId } = ctx.params;
    const membership = await assertMember(roomId, ctx.state.userId);

    if (!membership) {
      ctx.status = 403;
      ctx.body = { error: "Not a member of this room" };
      return;
    }

    const limit = Math.min(Number(ctx.query.limit) || 50, 100);
    const before = ctx.query.before as string | undefined;

    const msgs = await db.query.messages.findMany({
      where: and(
        eq(schema.messages.roomId, roomId),
        isNull(schema.messages.deletedAt),
        before ? lt(schema.messages.createdAt, new Date(before)) : undefined
      ),
      with: {
        sender: {
          columns: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        reactions: {
          with: { user: { columns: { id: true, username: true } } },
        },
        attachments: true,
        reads: {
          with: {
            user: { columns: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
        replyTo: {
          columns: { id: true, content: true },
          with: {
            sender: { columns: { id: true, username: true, displayName: true } },
          },
        },
      },
      orderBy: desc(schema.messages.createdAt),
      limit: limit + 1,
    });

    const hasMore = msgs.length > limit;
    if (hasMore) msgs.pop();

    const readAt = new Date();
    const markReadsTask =
      msgs.length > 0
        ? db
            .insert(schema.messageReads)
            .values(
              msgs.map((m) => ({
                messageId: m.id,
                userId: ctx.state.userId,
                readAt,
              }))
            )
            .onConflictDoNothing({
              target: [schema.messageReads.messageId, schema.messageReads.userId],
            })
        : Promise.resolve();
    const clearUnreadTask = db
      .update(schema.roomMembers)
      .set({ unreadCount: 0, lastReadAt: readAt })
      .where(
        and(
          eq(schema.roomMembers.roomId, roomId),
          eq(schema.roomMembers.userId, ctx.state.userId)
        )
      );
    void Promise.all([markReadsTask, clearUnreadTask]).catch((err) => {
      console.error("Failed to update read state:", err);
    });

    ctx.body = {
      messages: msgs.reverse(),
      hasMore,
      cursor: msgs.length > 0 ? msgs[0].createdAt : null,
    };
  });

  // ─── POST /  (send message) ─────────────────────────────────────────────────

  router.post("/", requireAuth, async (ctx) => {
    const { roomId } = ctx.params;
    const membership = await assertMember(roomId, ctx.state.userId);

    if (!membership) {
      ctx.status = 403;
      ctx.body = { error: "Not a member of this room" };
      return;
    }

    const result = sendMessageSchema.safeParse(ctx.request.body);
    if (!result.success) {
      ctx.status = 400;
      ctx.body = { error: "Validation failed", details: result.error.flatten() };
      return;
    }

    const { content, type, replyToId, attachmentIds } = result.data;
    const normalizedContent = content.trim();
    if (!normalizedContent && attachmentIds.length === 0) {
      ctx.status = 400;
      ctx.body = { error: "Message content or attachment is required" };
      return;
    }

    const messageType = attachmentIds.length > 0 && type === "text" ? "image" : type;
    const messageContent = normalizedContent || "[attachment]";

    const [message] = await db
      .insert(schema.messages)
      .values({ roomId, senderId: ctx.state.userId, content: messageContent, type: messageType, replyToId })
      .returning();

    if (attachmentIds.length > 0) {
      await db
        .update(schema.attachments)
        .set({ messageId: message.id })
        .where(
          and(
            inArray(schema.attachments.id, attachmentIds),
            eq(schema.attachments.uploaderId, ctx.state.userId),
            isNull(schema.attachments.messageId)
          )
        );
    }

    void db
      .insert(schema.messageReads)
      .values({ messageId: message.id, userId: ctx.state.userId, readAt: new Date() })
      .onConflictDoNothing({
        target: [schema.messageReads.messageId, schema.messageReads.userId],
      })
      .catch((err) => {
        console.error("Failed to mark sender read state:", err);
      });

    void db
      .execute(sql`
        UPDATE room_members
        SET unread_count = unread_count + 1
        WHERE room_id = ${roomId}
        AND user_id != ${ctx.state.userId}
      `)
      .catch((err) => {
        console.error("Failed to increment unread counts:", err);
      });

    void (async () => {
      // Keep relation.strength aligned with direct-message activity.
      const room = await db.query.rooms.findFirst({
        where: eq(schema.rooms.id, roomId),
        columns: { id: true, type: true },
      });
      if (!room || room.type !== "direct") return;

      const members = await db.query.roomMembers.findMany({
        where: eq(schema.roomMembers.roomId, roomId),
        columns: { userId: true },
      });
      if (members.length !== 2) return;

      const senderId = ctx.state.userId;
      const otherId = members.find((m) => m.userId !== senderId)?.userId;
      if (!otherId) return;

      const countRow = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.messages)
        .where(and(eq(schema.messages.roomId, roomId), isNull(schema.messages.deletedAt)));
      const messageCount = Number(countRow[0]?.count || 0);
      const strength = Math.max(1, Math.min(100, messageCount));

      await db
        .insert(schema.relation)
        .values([
          {
            userId: senderId,
            relatedUserId: otherId,
            type: "friend",
            viaUserId: otherId,
            strength,
            updatedAt: new Date(),
          },
          {
            userId: otherId,
            relatedUserId: senderId,
            type: "friend",
            viaUserId: senderId,
            strength,
            updatedAt: new Date(),
          },
        ])
        .onConflictDoUpdate({
          target: [
            schema.relation.userId,
            schema.relation.relatedUserId,
            schema.relation.type,
            schema.relation.viaUserId,
          ],
          set: { strength, updatedAt: new Date() },
        });
    })().catch((err) => {
      console.error("Failed to update relation strength:", err);
    });

    const fullMessage = await db.query.messages.findFirst({
      where: eq(schema.messages.id, message.id),
      with: {
        sender: {
          columns: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        reactions: true,
        attachments: true,
        reads: {
          with: {
            user: { columns: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
        replyTo: {
          columns: { id: true, content: true },
          with: {
            sender: { columns: { id: true, username: true, displayName: true } },
          },
        },
      },
    });

    // Broadcast to room via WebSocket
    if (wss) {
      wss.broadcastToRoom(roomId, { 
        type: "message:new", 
        payload: fullMessage 
      });

      // Auto-stop typing indicator for sender and clear typing timer.
      wss.stopTypingForUser(roomId, ctx.state.userId);
    }

    ctx.status = 201;
    ctx.body = { message: fullMessage };
  });

  // ─── PATCH /:messageId  (edit) ──────────────────────────────────────────────

  router.patch("/:messageId", requireAuth, async (ctx) => {
    const { messageId, roomId } = ctx.params;

    const message = await db.query.messages.findFirst({
      where: eq(schema.messages.id, messageId),
    });

    if (!message || message.deletedAt) {
      ctx.status = 404;
      ctx.body = { error: "Message not found" };
      return;
    }

    if (message.senderId !== ctx.state.userId) {
      ctx.status = 403;
      ctx.body = { error: "Cannot edit another user's message" };
      return;
    }

    const { content } = (ctx.request.body as any) || {};
    if (!content || typeof content !== "string" || !content.trim()) {
      ctx.status = 400;
      ctx.body = { error: "Content is required" };
      return;
    }

    const [updated] = await db
      .update(schema.messages)
      .set({ content: content.trim(), editedAt: new Date() })
      .where(eq(schema.messages.id, messageId))
      .returning();

    // Get full message with relations
    const fullMessage = await db.query.messages.findFirst({
      where: eq(schema.messages.id, messageId),
      with: {
        sender: {
          columns: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        reactions: {
          with: { user: { columns: { id: true, username: true } } },
        },
        attachments: true,
      },
    });

    // Broadcast edit event via WebSocket
    if (wss) {
      wss.broadcastToRoom(message.roomId, { 
        type: "message:edited", 
        payload: fullMessage 
      });
    }

    ctx.body = { message: fullMessage };
  });

  // ─── DELETE /:messageId  (soft delete) ─────────────────────────────────────

  router.delete("/:messageId", requireAuth, async (ctx) => {
    const { messageId, roomId } = ctx.params;

    const message = await db.query.messages.findFirst({
      where: eq(schema.messages.id, messageId),
    });

    if (!message || message.deletedAt) {
      ctx.status = 404;
      ctx.body = { error: "Message not found" };
      return;
    }

    if (message.senderId !== ctx.state.userId) {
      const membership = await assertMember(message.roomId, ctx.state.userId);
      if (!membership || !["admin", "owner"].includes(membership.role)) {
        ctx.status = 403;
        ctx.body = { error: "Cannot delete this message" };
        return;
      }
    }

    await db
      .update(schema.messages)
      .set({ deletedAt: new Date() })
      .where(eq(schema.messages.id, messageId));

    // Broadcast delete event via WebSocket
    if (wss) {
      wss.broadcastToRoom(message.roomId, {
        type: "message:deleted",
        payload: { messageId, roomId: message.roomId },
      });
    }

    ctx.body = { success: true };
  });

  // ─── POST /:messageId/react  (toggle reaction) ──────────────────────────────

  router.post("/:messageId/react", requireAuth, async (ctx) => {
    const { messageId, roomId } = ctx.params;
    const { emoji } = (ctx.request.body as any) || {};

    if (!emoji || typeof emoji !== "string") {
      ctx.status = 400;
      ctx.body = { error: "Emoji is required" };
      return;
    }

    const membership = await assertMember(roomId, ctx.state.userId);
    if (!membership) {
      ctx.status = 403;
      ctx.body = { error: "Not a member" };
      return;
    }

    const existing = await db.query.reactions.findFirst({
      where: and(
        eq(schema.reactions.messageId, messageId),
        eq(schema.reactions.userId, ctx.state.userId),
        eq(schema.reactions.emoji, emoji)
      ),
    });

    if (existing) {
      await db.delete(schema.reactions).where(eq(schema.reactions.id, existing.id));
    } else {
      await db.insert(schema.reactions).values({ messageId, userId: ctx.state.userId, emoji });
    }

    const reactions = await db.query.reactions.findMany({
      where: eq(schema.reactions.messageId, messageId),
      with: { user: { columns: { id: true, username: true } } },
    });

    // Broadcast reaction update via WebSocket
    if (wss) {
      wss.broadcastToRoom(roomId, {
        type: "message:reaction",
        payload: { messageId, reactions },
      });
    }

    ctx.body = { reactions, removed: !!existing };
  });

  // ─── POST /typing/start  (typing indicator) ────────────────────────────────

  router.post("/typing/start", requireAuth, async (ctx) => {
    const { roomId } = ctx.params;
    
    const membership = await assertMember(roomId, ctx.state.userId);
    if (!membership) {
      ctx.status = 403;
      ctx.body = { error: "Not a member" };
      return;
    }

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, ctx.state.userId),
      columns: { id: true, username: true, displayName: true }
    });

    if (wss && user) {
      wss.broadcastToRoom(roomId, {
        type: "typing:start",
        payload: {
          userId: user.id,
          username: user.displayName || user.username,
          roomId
        }
      });
    }

    ctx.status = 204;
  });

  // ─── POST /typing/stop  (stop typing indicator) ────────────────────────────

  router.post("/typing/stop", requireAuth, async (ctx) => {
    const { roomId } = ctx.params;
    
    const membership = await assertMember(roomId, ctx.state.userId);
    if (!membership) {
      ctx.status = 403;
      ctx.body = { error: "Not a member" };
      return;
    }

    if (wss) {
      wss.broadcastToRoom(roomId, {
        type: "typing:stop",
        payload: {
          userId: ctx.state.userId,
          roomId
        }
      });
    }

    ctx.status = 204;
  });

  return router;
}
