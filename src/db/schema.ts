import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  pgEnum,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const roomTypeEnum = pgEnum("room_type", ["direct", "group", "channel"]);
export const messageTypeEnum = pgEnum("message_type", [
  "text",
  "image",
  "system",
]);
export const memberRoleEnum = pgEnum("member_role", [
  "owner",
  "admin",
  "member",
]);

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  isOnline: boolean("is_online").default(false),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ─── Rooms ────────────────────────────────────────────────────────────────────

export const rooms = pgTable("rooms", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
  description: text("description"),
  type: roomTypeEnum("type").default("group").notNull(),
  slug: text("slug").unique(),
  isArchived: boolean("is_archived").default(false),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ─── Room Members ─────────────────────────────────────────────────────────────

export const roomMembers = pgTable(
  "room_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").default("member").notNull(),
    unreadCount: integer("unread_count").default(0),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniqueRoomUser: unique().on(t.roomId, t.userId),
    roomIdx: index("room_members_room_idx").on(t.roomId),
    userIdx: index("room_members_user_idx").on(t.userId),
  })
);

// ─── Messages ─────────────────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    type: messageTypeEnum("type").default("text").notNull(),
    replyToId: uuid("reply_to_id"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    roomIdx: index("messages_room_idx").on(t.roomId),
    senderIdx: index("messages_sender_idx").on(t.senderId),
    createdAtIdx: index("messages_created_at_idx").on(t.createdAt),
  })
);

// ─── Reactions ────────────────────────────────────────────────────────────────

export const reactions = pgTable(
  "reactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniqueReaction: unique().on(t.messageId, t.userId, t.emoji),
    messageIdx: index("reactions_message_idx").on(t.messageId),
  })
);

// ─── Refresh Tokens ───────────────────────────────────────────────────────────

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  roomMembers: many(roomMembers),
  sentMessages: many(messages),
  reactions: many(reactions),
  refreshTokens: many(refreshTokens),
}));

export const roomsRelations = relations(rooms, ({ many, one }) => ({
  members: many(roomMembers),
  messages: many(messages),
  creator: one(users, { fields: [rooms.createdBy], references: [users.id] }),
}));

export const roomMembersRelations = relations(roomMembers, ({ one }) => ({
  room: one(rooms, { fields: [roomMembers.roomId], references: [rooms.id] }),
  user: one(users, { fields: [roomMembers.userId], references: [users.id] }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  room: one(rooms, { fields: [messages.roomId], references: [rooms.id] }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  replyTo: one(messages, {
    fields: [messages.replyToId],
    references: [messages.id],
  }),
  reactions: many(reactions),
}));

export const reactionsRelations = relations(reactions, ({ one }) => ({
  message: one(messages, {
    fields: [reactions.messageId],
    references: [messages.id],
  }),
  user: one(users, { fields: [reactions.userId], references: [users.id] }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type RoomMember = typeof roomMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Reaction = typeof reactions.$inferSelect;
