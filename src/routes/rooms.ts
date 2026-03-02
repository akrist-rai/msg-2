import Router from "@koa/router";
import { z } from "zod";
import { eq, and, inArray, desc, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";

export const roomsRouter = new Router({ prefix: "/api/rooms" });

// ─── List rooms for current user ──────────────────────────────────────────────

roomsRouter.get("/", requireAuth, async (ctx) => {
  const memberships = await db.query.roomMembers.findMany({
    where: eq(schema.roomMembers.userId, ctx.state.userId),
    with: {
      room: {
        columns: { id: true, name: true, description: true, type: true, slug: true, createdAt: true },
        with: {
          members: {
            columns: { userId: true },
            with: {
              user: {
                columns: { id: true, username: true, displayName: true, avatarUrl: true, isOnline: true },
              },
            },
          },
        },
      },
    },
    orderBy: desc(schema.roomMembers.joinedAt),
  });

  const roomIds = memberships.map((m) => m.roomId);

  const lastMessages =
    roomIds.length > 0
      ? await db
          .selectDistinctOn([schema.messages.roomId], {
            roomId: schema.messages.roomId,
            content: schema.messages.content,
            type: schema.messages.type,
            createdAt: schema.messages.createdAt,
            senderUsername: schema.users.username,
            senderDisplayName: schema.users.displayName,
          })
          .from(schema.messages)
          .leftJoin(schema.users, eq(schema.messages.senderId, schema.users.id))
          .where(and(inArray(schema.messages.roomId, roomIds), isNull(schema.messages.deletedAt)))
          .orderBy(schema.messages.roomId, desc(schema.messages.createdAt))
      : [];

  const lastMessageMap = new Map(lastMessages.map((m) => [m.roomId, m]));

  ctx.body = {
    rooms: memberships.map((m) => ({
      ...m.room,
      myRole: m.role,
      unreadCount: m.unreadCount,
      lastReadAt: m.lastReadAt,
      lastMessage: lastMessageMap.get(m.roomId) || null,
    })),
  };
});

// ─── Create room ──────────────────────────────────────────────────────────────

const createRoomSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: z.enum(["group", "channel"]).default("group"),
  memberIds: z.array(z.string().uuid()).optional().default([]),
});

roomsRouter.post("/", requireAuth, async (ctx) => {
  const result = createRoomSchema.safeParse(ctx.request.body);
  if (!result.success) {
    ctx.status = 400;
    ctx.body = { error: "Validation failed", details: result.error.flatten() };
    return;
  }

  const { name, description, type, memberIds } = result.data;
  const slug =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") +
    "-" + Math.random().toString(36).slice(2, 6);

  const [room] = await db
    .insert(schema.rooms)
    .values({ name, description, type, slug, createdBy: ctx.state.userId })
    .returning();

  const allMemberIds = [...new Set([ctx.state.userId, ...memberIds])];
  await db.insert(schema.roomMembers).values(
    allMemberIds.map((userId) => ({
      roomId: room.id,
      userId,
      role: userId === ctx.state.userId ? ("owner" as const) : ("member" as const),
    }))
  );

  await db.insert(schema.messages).values({
    roomId: room.id,
    senderId: ctx.state.userId,
    content: `Room "${name}" created`,
    type: "system",
  });

  ctx.status = 201;
  ctx.body = { room };
});

// ─── Static routes — MUST come before /:roomId ───────────────────────────────
// Koa Router matches in registration order. Any route with a literal path
// segment (browse, users, dm) must be registered before /:roomId or the
// wildcard param will consume the request first.

roomsRouter.get("/browse/public", requireAuth, async (ctx) => {
  const publicRooms = await db.query.rooms.findMany({
    where: eq(schema.rooms.type, "channel"),
    with: { members: { columns: { userId: true } } },
    orderBy: desc(schema.rooms.createdAt),
  });
  ctx.body = { rooms: publicRooms };
});

roomsRouter.get("/users/search", requireAuth, async (ctx) => {
  const q = (ctx.query.q as string) || "";
  if (q.length < 2) { ctx.body = { users: [] }; return; }

  const users = await db.query.users.findMany({
    where: sql`(${schema.users.username} ILIKE ${`%${q}%`} OR ${schema.users.displayName} ILIKE ${`%${q}%`})
               AND ${schema.users.id} != ${ctx.state.userId}`,
    columns: { id: true, username: true, displayName: true, avatarUrl: true, isOnline: true },
    limit: 10,
  });
  ctx.body = { users };
});

roomsRouter.post("/dm/:targetUserId", requireAuth, async (ctx) => {
  const { targetUserId } = ctx.params;
  const myId = ctx.state.userId;

  if (targetUserId === myId) {
    ctx.status = 400; ctx.body = { error: "Cannot DM yourself" }; return;
  }

  const targetUser = await db.query.users.findFirst({
    where: eq(schema.users.id, targetUserId),
    columns: { id: true, username: true, displayName: true },
  });
  if (!targetUser) { ctx.status = 404; ctx.body = { error: "User not found" }; return; }

  // Check if a DM already exists between these two users
  const existing = await db.execute(sql`
    SELECT r.id FROM rooms r
    JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = ${myId}
    JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = ${targetUserId}
    WHERE r.type = 'direct'
    AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) = 2
    LIMIT 1
  `);

  if (existing.length > 0) {
    const room = await db.query.rooms.findFirst({ where: eq(schema.rooms.id, (existing[0] as any).id) });
    ctx.body = { room, existing: true };
    return;
  }

  const [room] = await db.insert(schema.rooms).values({ type: "direct", createdBy: myId }).returning();
  await db.insert(schema.roomMembers).values([
    { roomId: room.id, userId: myId, role: "member" },
    { roomId: room.id, userId: targetUserId, role: "member" },
  ]);

  ctx.status = 201;
  ctx.body = { room, targetUser, existing: false };
});

// ─── /:roomId routes ──────────────────────────────────────────────────────────

roomsRouter.get("/:roomId", requireAuth, async (ctx) => {
  const { roomId } = ctx.params;

  const membership = await db.query.roomMembers.findFirst({
    where: and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.userId, ctx.state.userId)),
  });
  if (!membership) { ctx.status = 403; ctx.body = { error: "Not a member of this room" }; return; }

  const room = await db.query.rooms.findFirst({
    where: eq(schema.rooms.id, roomId),
    with: {
      members: {
        with: {
          user: {
            columns: { id: true, username: true, displayName: true, avatarUrl: true, isOnline: true, lastSeen: true },
          },
        },
      },
    },
  });

  ctx.body = { room, myRole: membership.role };
});

roomsRouter.post("/:roomId/join", requireAuth, async (ctx) => {
  const { roomId } = ctx.params;

  const room = await db.query.rooms.findFirst({ where: eq(schema.rooms.id, roomId) });
  if (!room) { ctx.status = 404; ctx.body = { error: "Room not found" }; return; }
  if (room.type === "direct") { ctx.status = 400; ctx.body = { error: "Cannot join a direct message room" }; return; }

  const existing = await db.query.roomMembers.findFirst({
    where: and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.userId, ctx.state.userId)),
  });
  if (existing) { ctx.status = 409; ctx.body = { error: "Already a member" }; return; }

  await db.insert(schema.roomMembers).values({ roomId, userId: ctx.state.userId, role: "member" });
  ctx.body = { success: true };
});

roomsRouter.delete("/:roomId/leave", requireAuth, async (ctx) => {
  const { roomId } = ctx.params;
  await db.delete(schema.roomMembers).where(
    and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.userId, ctx.state.userId))
  );
  ctx.body = { success: true };
});
