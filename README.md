# msg. — Minimal Real-Time Messaging App

A modern, terminal-inspired real-time messaging application built with **Bun + Koa**, **Supabase**, and **Drizzle ORM**.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## 🚀 Features

- 🔐 **Secure Authentication** - JWT with refresh token rotation
- 💬 **Real-Time Messaging** - WebSocket-powered instant messaging
- 👥 **Group Chats & DMs** - Create rooms or chat directly
- ✏️ **Rich Messaging** - Edit, delete, reply to messages
- 😄 **Emoji Reactions** - React to messages with emojis
- ✍️ **Typing Indicators** - See when others are typing
- 🟢 **Online Presence** - Real-time user status
- 📜 **Message History** - Infinite scroll with cursor-based pagination
- 🛡️ **Rate Limiting** - Built-in protection

## 📦 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | [Bun](https://bun.sh) |
| **Server** | [Koa](https://koajs.com) + @koa/router |
| **WebSocket** | [ws](https://github.com/websockets/ws) |
| **Database** | [Supabase](https://supabase.com) (PostgreSQL) |
| **ORM** | [Drizzle ORM](https://orm.drizzle.team) |
| **Validation** | [Zod](https://zod.dev) |
| **Auth** | JWT + bcrypt |

---

## 🛠️ Quick Start

### Prerequisites

- [Bun](https://bun.sh) installed
- [Supabase](https://supabase.com) account (free tier works)

### Installation

```bash
# 1. Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# 2. Clone the repository
git clone https://github.com/akrist-rai/msg-2.git
cd msg-2

# 3. Install dependencies
bun install

# 4. Set up environment variables
cp .env.example .env
```

### Environment Configuration

Edit `.env` with your Supabase credentials:

```env
PORT=3000

# Supabase credentials (from your Supabase dashboard)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres

# JWT secret (generate a secure random string)
JWT_SECRET=your-super-secret-jwt-key-change-this
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-this
```

**Finding your Supabase credentials:**

1. Go to your [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Navigate to **Settings → API**:
   - **SUPABASE_URL**: Project URL
   - **SUPABASE_ANON_KEY**: anon/public key
   - **SUPABASE_SERVICE_ROLE_KEY**: service_role key
4. Navigate to **Settings → Database**:
   - **DATABASE_URL**: Connection string (Session mode, port 5432)

### Database Setup

```bash
# Push schema to your Supabase database
bun run db:push

# Or generate and run migrations manually
bun run db:generate
bun run db:migrate
```

### Run the Application

```bash
# Development mode (with hot reload)
bun run dev

# Production mode
bun run start
```

Open your browser to **http://localhost:3000** 🎉

---

## 🔌 WebSocket Integration

The app uses WebSockets for real-time messaging. Connect to:

```
ws://localhost:3000/ws?token=<your-access-token>
```

For detailed WebSocket documentation, examples, and client libraries, see:
- **[WEBSOCKET.md](WEBSOCKET.md)** - Complete WebSocket guide
- **[client/](client/)** - Ready-to-use client libraries for JavaScript, TypeScript, and React

---

## 📚 REST API Reference

### Authentication

#### Register
```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "johndoe",
  "email": "john@example.com",
  "password": "securepassword123",
  "displayName": "John Doe"
}
```

**Response:**
```json
{
  "user": {
    "id": "user-uuid",
    "username": "johndoe",
    "email": "john@example.com",
    "displayName": "John Doe"
  },
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc..."
}
```

#### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "johndoe",
  "password": "securepassword123"
}
```

#### Refresh Token
```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "your-refresh-token"
}
```

#### Get Current User
```http
GET /api/auth/me
Authorization: Bearer <accessToken>
```

#### Update Profile
```http
PATCH /api/auth/me
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "displayName": "New Name",
  "avatarUrl": "https://example.com/avatar.jpg"
}
```

#### Logout
```http
POST /api/auth/logout
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "refreshToken": "your-refresh-token"
}
```

### Rooms

#### List My Rooms
```http
GET /api/rooms
Authorization: Bearer <accessToken>
```

#### Create Room
```http
POST /api/rooms
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "My Chat Room",
  "description": "A cool place to chat",
  "type": "group"  // or "channel"
}
```

#### Get Room Details
```http
GET /api/rooms/:roomId
Authorization: Bearer <accessToken>
```

#### Start Direct Message
```http
POST /api/rooms/dm/:userId
Authorization: Bearer <accessToken>
```

#### Join Room
```http
POST /api/rooms/:roomId/join
Authorization: Bearer <accessToken>
```

#### Leave Room
```http
DELETE /api/rooms/:roomId/leave
Authorization: Bearer <accessToken>
```

#### Search Users
```http
GET /api/rooms/users/search?q=john
Authorization: Bearer <accessToken>
```

### Messages

#### Get Messages (with pagination)
```http
GET /api/rooms/:roomId/messages?limit=50&cursor=message-id
Authorization: Bearer <accessToken>
```

**Query Parameters:**
- `limit` (optional): Number of messages (default: 50, max: 100)
- `cursor` (optional): Message ID to paginate from

#### Send Message
```http
POST /api/rooms/:roomId/messages
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "content": "Hello, world!",
  "type": "text",
  "replyToId": "message-id-optional"
}
```

#### Edit Message
```http
PATCH /api/rooms/:roomId/messages/:messageId
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "content": "Updated message content"
}
```

#### Delete Message
```http
DELETE /api/rooms/:roomId/messages/:messageId
Authorization: Bearer <accessToken>
```

#### Toggle Reaction
```http
POST /api/rooms/:roomId/messages/:messageId/react
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "emoji": "👍"
}
```

---

## 🗄️ Database Schema

```sql
-- Users table
users (
  id UUID PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  displayName TEXT,
  email TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  avatarUrl TEXT,
  isOnline BOOLEAN DEFAULT false,
  lastSeenAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT NOW()
)

-- Rooms table
rooms (
  id UUID PRIMARY KEY,
  name TEXT,
  description TEXT,
  type TEXT CHECK (type IN ('direct', 'group', 'channel')),
  slug TEXT UNIQUE,
  createdBy UUID REFERENCES users(id),
  createdAt TIMESTAMP DEFAULT NOW()
)

-- Room members
room_members (
  id UUID PRIMARY KEY,
  roomId UUID REFERENCES rooms(id),
  userId UUID REFERENCES users(id),
  role TEXT CHECK (role IN ('owner', 'admin', 'member')),
  unreadCount INTEGER DEFAULT 0,
  joinedAt TIMESTAMP DEFAULT NOW(),
  UNIQUE(roomId, userId)
)

-- Messages
messages (
  id UUID PRIMARY KEY,
  roomId UUID REFERENCES rooms(id),
  senderId UUID REFERENCES users(id),
  content TEXT NOT NULL,
  type TEXT CHECK (type IN ('text', 'image', 'system')),
  replyToId UUID REFERENCES messages(id),
  editedAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT NOW()
)

-- Reactions
reactions (
  id UUID PRIMARY KEY,
  messageId UUID REFERENCES messages(id),
  userId UUID REFERENCES users(id),
  emoji TEXT NOT NULL,
  createdAt TIMESTAMP DEFAULT NOW(),
  UNIQUE(messageId, userId, emoji)
)

-- Refresh tokens
refresh_tokens (
  id UUID PRIMARY KEY,
  userId UUID REFERENCES users(id),
  token TEXT UNIQUE NOT NULL,
  expiresAt TIMESTAMP NOT NULL,
  createdAt TIMESTAMP DEFAULT NOW()
)
```

---

## 📁 Project Structure

```
msg-2/
├── src/
│   ├── server.ts              # Main Koa app + HTTP server + WebSocket upgrade
│   ├── db/
│   │   ├── index.ts           # Drizzle + Supabase client initialization
│   │   └── schema.ts          # Database schema with relations
│   ├── middleware/
│   │   └── auth.ts            # JWT middleware + authentication helpers
│   ├── routes/
│   │   ├── auth.ts            # Authentication endpoints
│   │   ├── rooms.ts           # Room management endpoints
│   │   └── messages.ts        # Message CRUD + reactions
│   └── ws/
│       └── handler.ts         # WebSocket server + presence + typing indicators
├── public/
│   └── index.html             # Terminal-inspired SPA frontend
├── drizzle/                   # Database migrations
├── drizzle.config.ts          # Drizzle ORM configuration
├── package.json
├── tsconfig.json
├── bunfig.toml               # Bun configuration
├── .env.example
└── README.md
```

---

## 🔧 Development Commands

```bash
# Install dependencies
bun install

# Run development server with hot reload
bun run dev

# Run production server
bun run start

# Database operations
bun run db:push       # Push schema to database
bun run db:generate   # Generate migration files
bun run db:migrate    # Run migrations
bun run db:studio     # Open Drizzle Studio (database GUI)
```

---

## 🐛 Troubleshooting

### WebSocket Connection Issues

**Problem:** WebSocket connection fails with 401 Unauthorized
```
Solution: Ensure you're passing a valid access token in the URL:
ws://localhost:3000/ws?token=<valid-access-token>

Get a fresh token by logging in via POST /api/auth/login
```

**Problem:** Connection closes immediately
```
Solution: Check if your JWT_SECRET in .env matches the one used to create tokens.
Also verify the token hasn't expired (default: 15 minutes).
```

**Problem:** Not receiving messages
```
Solution: Ensure you're a member of the room. Join a room first via:
POST /api/rooms/:roomId/join
```

### Database Issues

**Problem:** `db:push` fails with connection error
```
Solution: Verify your DATABASE_URL is correct and includes the password.
Format: postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres
```

**Problem:** Relations not working
```
Solution: Run `bun run db:generate` and `bun run db:migrate` to apply all migrations.
```

### General Issues

**Problem:** Port 3000 already in use
```
Solution: Change PORT in .env or kill the process:
lsof -ti:3000 | xargs kill -9
```

---

## 🚀 Deployment

### Deploy to Production

1. **Set environment variables** on your hosting platform
2. **Build the application:**
   ```bash
   bun run build
   ```
3. **Start the server:**
   ```bash
   bun run start
   ```
---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

---

