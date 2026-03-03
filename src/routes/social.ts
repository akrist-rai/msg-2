import Router from "@koa/router";
import { and, eq, isNull, sql } from "drizzle-orm";
import { hash } from "bcryptjs";
import { db, schema } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";

type GraphUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isOnline: boolean | null;
  rawFreq: number;
  chatFreq: number;
};

function normalizeFreq(raw: number, max: number) {
  if (max <= 0) return 8;
  return Math.max(8, Math.round((raw / max) * 100));
}

async function buildGraphForUser(userId: string) {
  const me = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      isOnline: true,
    },
  });
  if (!me) return null;

  const relationRows = await db.query.relation.findMany({
    where: eq(schema.relation.userId, userId),
    with: {
      relatedUser: {
        columns: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          isOnline: true,
        },
      },
      viaUser: {
        columns: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          isOnline: true,
        },
      },
    },
  });

  const friendRows = relationRows.filter((r) => r.type === "friend");
  const fofRows = relationRows.filter((r) => r.type === "fof");

  const friendsRaw: GraphUser[] = friendRows
    .map((r) => {
      const u = r.relatedUser;
      if (!u) return null;
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl ?? null,
        isOnline: u.isOnline ?? null,
        rawFreq: Number(r.strength || 0),
        chatFreq: 0,
      } satisfies GraphUser;
    })
    .filter(Boolean) as GraphUser[];

  const friendIdSet = new Set(friendsRaw.map((f) => f.id));
  const fofById = new Map<string, GraphUser & { mutualFriendIds: Set<string> }>();

  for (const row of fofRows) {
    const u = row.relatedUser;
    if (!u) continue;
    if (u.id === userId || friendIdSet.has(u.id)) continue;
    const existing = fofById.get(u.id);
    if (!existing) {
      fofById.set(u.id, {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl ?? null,
        isOnline: u.isOnline ?? null,
        rawFreq: Number(row.strength || 0),
        chatFreq: 0,
        mutualFriendIds: new Set(row.viaUserId ? [row.viaUserId] : []),
      });
    } else {
      existing.rawFreq = Math.max(existing.rawFreq, Number(row.strength || 0));
      if (row.viaUserId) existing.mutualFriendIds.add(row.viaUserId);
    }
  }

  const maxRaw = Math.max(
    ...friendsRaw.map((f) => f.rawFreq),
    ...[...fofById.values()].map((n) => n.rawFreq),
    1
  );
  for (const friend of friendsRaw) friend.chatFreq = normalizeFreq(friend.rawFreq, maxRaw);

  const friendsOfFriends = [...fofById.values()].map((n) => ({
    id: n.id,
    username: n.username,
    displayName: n.displayName,
    avatarUrl: n.avatarUrl,
    isOnline: n.isOnline,
    rawFreq: n.rawFreq,
    chatFreq: normalizeFreq(n.rawFreq, maxRaw),
    mutualFriendIds: [...n.mutualFriendIds],
  }));

  const links = [
    ...friendsRaw.map((f) => ({ source: me.id, target: f.id, kind: "friend" as const })),
    ...friendsOfFriends.flatMap((fof) =>
      fof.mutualFriendIds.map((friendId) => ({
        source: friendId,
        target: fof.id,
        kind: "fof" as const,
      }))
    ),
  ];

  return {
    me: {
      id: me.id,
      username: me.username,
      displayName: me.displayName,
      avatarUrl: me.avatarUrl ?? null,
      isOnline: me.isOnline ?? null,
      chatFreq: 100,
    },
    friends: friendsRaw.map((f) => ({
      id: f.id,
      username: f.username,
      displayName: f.displayName,
      avatarUrl: f.avatarUrl,
      isOnline: f.isOnline,
      rawFreq: f.rawFreq,
      chatFreq: f.chatFreq,
      roomId: null,
    })),
    friendsOfFriends,
    links,
  };
}

async function upsertRelationEdge(params: {
  userId: string;
  relatedUserId: string;
  type: "friend" | "fof";
  viaUserId: string;
  strength: number;
}) {
  await db
    .insert(schema.relation)
    .values({
      userId: params.userId,
      relatedUserId: params.relatedUserId,
      type: params.type,
      viaUserId: params.viaUserId,
      strength: params.strength,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.relation.userId,
        schema.relation.relatedUserId,
        schema.relation.type,
        schema.relation.viaUserId,
      ],
      set: {
        strength: params.strength,
        updatedAt: new Date(),
      },
    });
}

async function findOrCreateUser(params: {
  username: string;
  displayName: string;
  email: string;
}) {
  const existing = await db.query.users.findFirst({
    where: eq(schema.users.username, params.username),
    columns: { id: true, username: true, displayName: true, email: true },
  });
  if (existing) return existing;

  const passwordHash = await hash("Passw0rd!123", 10);
  const [created] = await db
    .insert(schema.users)
    .values({
      username: params.username,
      displayName: params.displayName,
      email: params.email,
      passwordHash,
      isOnline: false,
    })
    .returning({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      email: schema.users.email,
    });
  return created;
}

async function findOrCreateDirectRoom(userA: string, userB: string) {
  const existing = await db.execute(sql`
    SELECT r.id
    FROM rooms r
    JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = ${userA}
    JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = ${userB}
    WHERE r.type = 'direct'
      AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) = 2
    LIMIT 1
  `);

  const existingId = (existing[0] as { id?: string } | undefined)?.id;
  if (existingId) return existingId;

  const [room] = await db
    .insert(schema.rooms)
    .values({ type: "direct", createdBy: userA })
    .returning({ id: schema.rooms.id });

  await db.insert(schema.roomMembers).values([
    { roomId: room.id, userId: userA, role: "member" },
    { roomId: room.id, userId: userB, role: "member" },
  ]);

  return room.id;
}

async function seedConversation(
  roomId: string,
  userA: string,
  userB: string,
  totalMessages: number
) {
  const existing = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.messages)
    .where(and(eq(schema.messages.roomId, roomId), isNull(schema.messages.deletedAt)));
  const existingCount = Number(existing[0]?.count || 0);
  if (existingCount >= totalMessages) return;

  const toCreate = totalMessages - existingCount;
  const now = Date.now();
  const rows = Array.from({ length: toCreate }, (_, idx) => {
    const senderId = idx % 2 === 0 ? userA : userB;
    const minutesAgo = (toCreate - idx) * 11;
    return {
      roomId,
      senderId,
      type: "text" as const,
      content: `Seeded message ${existingCount + idx + 1}`,
      createdAt: new Date(now - minutesAgo * 60_000),
    };
  });

  await db.insert(schema.messages).values(rows);
}

export const socialRouter = new Router({ prefix: "/social" });

socialRouter.get("/graph", requireAuth, async (ctx) => {
  const graph = await buildGraphForUser(ctx.state.userId);
  if (!graph) {
    ctx.status = 404;
    ctx.body = { error: "User not found" };
    return;
  }
  ctx.body = graph;
});

socialRouter.post("/seed-dummy", requireAuth, async (ctx) => {
  const meId = ctx.state.userId as string;

  const friendTemplates = [
    { username: "seed_ava", displayName: "Ava Stone", email: "seed_ava@example.com", freq: 90 },
    { username: "seed_noah", displayName: "Noah Reed", email: "seed_noah@example.com", freq: 70 },
    { username: "seed_maya", displayName: "Maya Chen", email: "seed_maya@example.com", freq: 55 },
    { username: "seed_leo", displayName: "Leo Carter", email: "seed_leo@example.com", freq: 35 },
    { username: "seed_zoe", displayName: "Zoe Park", email: "seed_zoe@example.com", freq: 20 },
  ];
  const fofTemplates = [
    { username: "seed_jon", displayName: "Jon Bell", email: "seed_jon@example.com" },
    { username: "seed_rhea", displayName: "Rhea Ray", email: "seed_rhea@example.com" },
    { username: "seed_lina", displayName: "Lina Moss", email: "seed_lina@example.com" },
    { username: "seed_yuri", displayName: "Yuri Kade", email: "seed_yuri@example.com" },
    { username: "seed_kai", displayName: "Kai Vale", email: "seed_kai@example.com" },
  ];

  const createdUsers: string[] = [];
  const friends = [];
  for (const tpl of friendTemplates) {
    const user = await findOrCreateUser(tpl);
    friends.push({ ...user, freq: tpl.freq });
    createdUsers.push(user.username);
  }
  const others = [];
  for (const tpl of fofTemplates) {
    const user = await findOrCreateUser(tpl);
    others.push(user);
    createdUsers.push(user.username);
  }

  const otherIdByUsername = new Map(others.map((o) => [o.username, o.id]));

  for (const friend of friends) {
    const roomId = await findOrCreateDirectRoom(meId, friend.id);
    await seedConversation(roomId, meId, friend.id, friend.freq);
    await upsertRelationEdge({
      userId: meId,
      relatedUserId: friend.id,
      type: "friend",
      viaUserId: friend.id,
      strength: friend.freq,
    });
    // reciprocal edge so seeded users also have usable graph data when they log in
    await upsertRelationEdge({
      userId: friend.id,
      relatedUserId: meId,
      type: "friend",
      viaUserId: meId,
      strength: friend.freq,
    });
  }

  const fofEdges: Array<{ friendUsername: string; otherUsername: string; freq: number }> = [
    { friendUsername: "seed_ava", otherUsername: "seed_jon", freq: 22 },
    { friendUsername: "seed_ava", otherUsername: "seed_rhea", freq: 15 },
    { friendUsername: "seed_noah", otherUsername: "seed_rhea", freq: 19 },
    { friendUsername: "seed_noah", otherUsername: "seed_lina", freq: 12 },
    { friendUsername: "seed_maya", otherUsername: "seed_yuri", freq: 10 },
    { friendUsername: "seed_leo", otherUsername: "seed_kai", freq: 8 },
    { friendUsername: "seed_zoe", otherUsername: "seed_kai", freq: 7 },
  ];

  const friendIdByUsername = new Map(friends.map((f) => [f.username, f.id]));
  for (const edge of fofEdges) {
    const friendId = friendIdByUsername.get(edge.friendUsername);
    const otherId = otherIdByUsername.get(edge.otherUsername);
    if (!friendId || !otherId) continue;
    const roomId = await findOrCreateDirectRoom(friendId, otherId);
    await seedConversation(roomId, friendId, otherId, edge.freq);
    await upsertRelationEdge({
      userId: meId,
      relatedUserId: otherId,
      type: "fof",
      viaUserId: friendId,
      strength: edge.freq,
    });
  }

  const graph = await buildGraphForUser(meId);
  ctx.body = {
    ok: true,
    seededUsers: [...new Set(createdUsers)],
    graph,
  };
});
