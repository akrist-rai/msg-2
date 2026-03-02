# msg. — Minimal Messaging App

A real-time messaging application built with **Koa + Bun**, **Supabase**, and **Drizzle ORM**.

## Stack

| Layer | Tech |
|-------|------|
| Runtime | [Bun](https://bun.sh) |
| HTTP Server | [Koa](https://koajs.com) + @koa/router |
| WebSocket | [ws](https://github.com/websockets/ws) |
| Database | [Supabase](https://supabase.com) (Postgres) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) |
| Validation | [Zod](https://zod.dev) |
| Auth | JWT (access + refresh tokens) + bcrypt |

## Features

- 🔐 JWT auth with refresh token rotation
- 💬 Real-time messaging via WebSockets
- 👥 Group rooms + Direct messages
- ✏️ Edit & delete messages
- ↩️ Message replies
- 😄 Emoji reactions (toggle)
- ✍️ Typing indicators
- 🟢 Online presence
- 📜 Infinite scroll message history (cursor-based pagination)
- 🛡️ Basic rate limiting

## Setup

### 1. Install Bun
```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Install dependencies
```bash
bun install
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your Supabase credentials
```

Get your credentials from your Supabase project:
- **SUPABASE_URL** → Project Settings → API → Project URL
- **SUPABASE_ANON_KEY** → Project Settings → API → anon/public key
- **SUPABASE_SERVICE_ROLE_KEY** → Project Settings → API → service_role key
- **DATABASE_URL** → Project Settings → Database → Connection string (Session mode, port 5432)

### 4. Push schema to Supabase
```bash
bun run db:push
```

Or generate migration files first:
```bash
bun run db:generate
bun run db:migrate
```

### 5. Run
```bash
# Development (with hot reload)
bun run dev

# Production
bun run start
```

Open http://localhost:3000

## API Reference

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Get current user |
| PATCH | `/api/auth/me` | Update profile |

### Rooms
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rooms` | List my rooms |
| POST | `/api/rooms` | Create room |
| GET | `/api/rooms/:id` | Get room details |
| POST | `/api/rooms/dm/:userId` | Start DM |
| POST | `/api/rooms/:id/join` | Join room |
| DELETE | `/api/rooms/:id/leave` | Leave room |
| GET | `/api/rooms/users/search?q=` | Search users |

### Messages
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rooms/:id/messages` | Get messages (paginated) |
| POST | `/api/rooms/:id/messages` | Send message |
| PATCH | `/api/rooms/:id/messages/:msgId` | Edit message |
| DELETE | `/api/rooms/:id/messages/:msgId` | Delete message |
| POST | `/api/rooms/:id/messages/:msgId/react` | Toggle reaction |

### WebSocket

Connect to `ws://localhost:3000/ws?token=<accessToken>`

**Client → Server events:**
```json
{ "type": "typing:start", "payload": { "roomId": "..." } }
{ "type": "typing:stop",  "payload": { "roomId": "..." } }
{ "type": "ping" }
```

**Server → Client events:**
```json
{ "type": "message:new",      "payload": { ...message } }
{ "type": "message:edited",   "payload": { ...message } }
{ "type": "message:deleted",  "payload": { "messageId": "...", "roomId": "..." } }
{ "type": "message:reaction", "payload": { "messageId": "...", "reactions": [...] } }
{ "type": "typing:start",     "payload": { "userId": "...", "username": "...", "roomId": "..." } }
{ "type": "typing:stop",      "payload": { "userId": "...", "roomId": "..." } }
{ "type": "presence",         "payload": { "userId": "...", "isOnline": true } }
```

## Database Schema

```
users          → id, username, displayName, email, passwordHash, avatarUrl, isOnline, ...
rooms          → id, name, description, type (direct|group|channel), slug, createdBy, ...
room_members   → id, roomId, userId, role (owner|admin|member), unreadCount, ...
messages       → id, roomId, senderId, content, type (text|image|system), replyToId, editedAt, ...
reactions      → id, messageId, userId, emoji
refresh_tokens → id, userId, token, expiresAt
```

## Project Structure

```
messaging-app/
├── src/
│   ├── server.ts          # Koa app + HTTP server + WS upgrade
│   ├── db/
│   │   ├── index.ts       # Drizzle + Supabase clients
│   │   └── schema.ts      # Full DB schema with relations
│   ├── middleware/
│   │   └── auth.ts        # JWT middleware + helpers
│   ├── routes/
│   │   ├── auth.ts        # Auth endpoints
│   │   ├── rooms.ts       # Room CRUD + DM
│   │   └── messages.ts    # Message CRUD + reactions
│   └── ws/
│       └── handler.ts     # WebSocket server + presence + typing
├── public/
│   └── index.html         # SPA frontend (terminal-inspired UI)
├── drizzle.config.ts
├── package.json
└── .env.example
```
