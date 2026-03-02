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
  "system",
]);
export const memberRoleEnum = pgEnum("member_role", [
  "owner",
  "admin",
  "member",
]);
export const attachmentTypeEnum = pgEnum("attachment_type", [
  "image",
  "video",
  "audio",
  "document",
]);
/**   refrence for message attachments:
 * Attachment categories — used to decide how the frontend renders the file.
 * "image"    → show inline <img>
 * "video"    → show inline <video> player
 * "audio"    → show inline <audio> player
 * "document" → show a download card with filename + size
 */

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:           uuid("id").defaultRandom().primaryKey(),
  username:     text("username").notNull().unique(),
  displayName:  text("display_name").notNull(),
  email:        text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  avatarUrl:    text("avatar_url"),
  bio:          text("bio"),
  isOnline:     boolean("is_online").default(false),
  lastSeen:     timestamp("last_seen", { withTimezone: true }),
  createdAt:    timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt:    timestamp("updated_at", { withTimezone: true })
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

// ═══════════════════════════════════════════════════════════════════════════════
// ATTACHMENTS
//
// WHY A SEPARATE TABLE?
// A message can have multiple attachments (e.g. a user drops 3 images at once).
// Keeping them in a separate table with a foreign key to messages lets us:
//   - Query just the attachments for a message
//   - Upload a file before the message exists (message_id is nullable here)
//   - Easily add metadata (dimensions, duration) per file
//
// HOW SUPABASE STORAGE WORKS:
//   1. Files live in a "bucket" (like an S3 bucket).
//   2. You upload via supabase.storage.from("bucket").upload(path, file).
//   3. The `storage_path` column stores the path inside the bucket.
//   4. The `public_url` is the CDN URL users actually load the file from.
//      For public buckets this never expires; for private buckets you'd
//      generate a signed URL at read time.
// ═══════════════════════════════════════════════════════════════════════════════

export const attachments = pgTable(
  "attachments",
  {
    id:              uuid("id").defaultRandom().primaryKey(),
    // nullable while the file is uploaded but the message hasn't been sent yet
    messageId:       uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    uploaderId:      uuid("uploader_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    attachmentType:  attachmentTypeEnum("attachment_type").notNull(),
    storagePath:     text("storage_path").notNull(),   // e.g. "user-id/filename-uuid.jpg"
    publicUrl:       text("public_url").notNull(),      // full CDN URL
    filename:        text("filename").notNull(),         // original filename shown to users
    mimeType:        text("mime_type").notNull(),        // e.g. "image/jpeg"
    // bigint because files can be > 2 GB; JavaScript reads bigint as string by default
    size:            bigint("size", { mode: "number" }).notNull(),
    // images / videos only
    width:           integer("width"),
    height:          integer("height"),
    // videos / audio only (seconds)
    durationSeconds: integer("duration_seconds"),
    createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    messageIdx:  index("attachments_message_idx").on(t.messageId),
    uploaderIdx: index("attachments_uploader_idx").on(t.uploaderId),
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE READS  ("seen receipts")
//
// WHY NOT JUST USE room_members.last_read_at?
// last_read_at tells us WHEN a user last read the room, but not WHICH messages
// they've seen. With a per-message read table we can show "Seen by Alice at 14:32"
// on each individual message.
//
// SCALABILITY NOTE:
// In very large rooms (thousands of members) this table would grow huge.
// For now it's fine for a learning project. Production systems often use
// a "high-water mark" approach instead (storing only the latest-read message ID).
// ═══════════════════════════════════════════════════════════════════════════════

export const messageReads = pgTable(
  "message_reads",
  {
    id:        uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    userId:    uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    readAt:    timestamp("read_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // A user can only read a message once — ON CONFLICT DO NOTHING is used at insert time
    uniqueRead:  unique().on(t.messageId, t.userId),
    messageIdx:  index("message_reads_message_idx").on(t.messageId),
    userIdx:     index("message_reads_user_idx").on(t.userId),
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
  messageReads:  many(messageReads),
  attachments:   many(attachments),
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
  replyTo: one(messages, {fields: [messages.replyToId],references: [messages.id],
  }),
  reactions: many(reactions),
    attachments: many(attachments),  
  reads:       many(messageReads),  
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  message:  one(messages, { fields: [attachments.messageId],  references: [messages.id] }),
  uploader: one(users,    { fields: [attachments.uploaderId], references: [users.id]    }),
}));

export const messageReadsRelations = relations(messageReads, ({ one }) => ({
  message: one(messages, { fields: [messageReads.messageId], references: [messages.id] }),
  user:    one(users,    { fields: [messageReads.userId],    references: [users.id]    }),
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
