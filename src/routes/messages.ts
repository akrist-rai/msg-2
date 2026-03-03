import Router from "@koa/router";
import { z } from "zod";
import { eq, and, lt, desc, isNull, sql, inArray } from "drizzle-orm";
import { db, schema, supabase } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { WebSocketServer } from "../ws/handler.ts";

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

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createMessagesRouter(wss?: WebSocketServer) {
  const router = new Router({ prefix: "/rooms/:roomId/messages" });

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
    const extension =
      filename.includes(".") && filename.lastIndexOf(".") > 0
        ? filename.slice(filename.lastIndexOf("."))
        : "";
    const storagePath = `${ctx.state.userId}/${Date.now()}-${crypto.randomUUID()}${extension}`;

    const fileBytes = await Bun.file(file.filepath).arrayBuffer();
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

    const [attachment] = await db
      .insert(schema.attachments)
      .values({
        messageId: null,
        uploaderId: ctx.state.userId,
        attachmentType,
        storagePath,
        publicUrl: publicData.publicUrl,
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

    if (msgs.length > 0) {
      await db
        .insert(schema.messageReads)
        .values(
          msgs.map((m) => ({
            messageId: m.id,
            userId: ctx.state.userId,
            readAt: new Date(),
          }))
        )
        .onConflictDoNothing({
          target: [schema.messageReads.messageId, schema.messageReads.userId],
        });
    }

    await db
      .update(schema.roomMembers)
      .set({ unreadCount: 0, lastReadAt: new Date() })
      .where(
        and(
          eq(schema.roomMembers.roomId, roomId),
          eq(schema.roomMembers.userId, ctx.state.userId)
        )
      );

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

    await db
      .insert(schema.messageReads)
      .values({ messageId: message.id, userId: ctx.state.userId, readAt: new Date() })
      .onConflictDoNothing({
        target: [schema.messageReads.messageId, schema.messageReads.userId],
      });

    await db.execute(sql`
      UPDATE room_members
      SET unread_count = unread_count + 1
      WHERE room_id = ${roomId}
      AND user_id != ${ctx.state.userId}
    `);

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

    wss?.broadcastToRoom(roomId, { type: "message:new", payload: fullMessage });

    ctx.status = 201;
    ctx.body = { message: fullMessage };
  });

  // ─── PATCH /:messageId  (edit) ──────────────────────────────────────────────

  router.patch("/:messageId", requireAuth, async (ctx) => {
    const { messageId } = ctx.params;

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

    wss?.broadcastToRoom(message.roomId, { type: "message:edited", payload: updated });

    ctx.body = { message: updated };
  });

  // ─── DELETE /:messageId  (soft delete) ─────────────────────────────────────

  router.delete("/:messageId", requireAuth, async (ctx) => {
    const { messageId } = ctx.params;

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

    wss?.broadcastToRoom(message.roomId, {
      type: "message:deleted",
      payload: { messageId, roomId: message.roomId },
    });

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

    wss?.broadcastToRoom(roomId, {
      type: "message:reaction",
      payload: { messageId, reactions },
    });

    ctx.body = { reactions, removed: !!existing };
  });

  return router;
}
