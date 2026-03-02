import Koa, { type Context } from "koa";
import Router from "@koa/router";
import cors from "@koa/cors";
import koaBody from "koa-body";
import serve from "koa-static";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

// setting up routes
import { authRouter } from "./routes/auth.ts";
import { roomsRouter } from "./routes/rooms.ts";
import { createMessagesRouter } from "./routes/messages.ts";
import { WebSocketServer } from "./ws/handler.ts";
import { checkDbHealth } from "./db/index.ts";
import errorHandler from "./middleware/errorhandler.ts";

//seting up middleware

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isDev = process.env.NODE_ENV !== "production";

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = new Koa();

// Trust proxy headers (e.g. X-Forwarded-For)
app.proxy = true;

// ─── Error Handling ───────────────────────────────────────────────────────────

app.use(errorHandler);
// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  cors({
    origin: (ctx) => {
      const allowed = process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000", "http://localhost:5173"];
      const origin = ctx.request.headers.origin || "";
      return allowed.includes(origin) ? origin : allowed[0];
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(
  koaBody({
    json: true,
    multipart: true,
    jsonLimit: "1mb",
    formLimit: "1mb",
  })
);

// Request logging in dev
if (isDev) {
  app.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`${ctx.method} ${ctx.path} ${ctx.status} - ${ms}ms`);
  });
}

// ─── Rate Limiting (simple in-memory) ────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

app.use(async (ctx, next) => {
  if (!ctx.path.startsWith("/api/auth")) return next();

  const ip = ctx.ip || "unknown";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 min
  const maxRequests = 20;

  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > maxRequests) {
    ctx.status = 429;
    ctx.body = { error: "Too many requests, please try again later" };
    return;
  }

  ctx.set("X-RateLimit-Limit", String(maxRequests));
  ctx.set("X-RateLimit-Remaining", String(Math.max(0, maxRequests - entry.count)));
  await next();
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer();

// ─── Routes ───────────────────────────────────────────────────────────────────

const apiRouter = new Router();

apiRouter.get("/api/health", async (ctx: Context) => {
  const dbOk = await checkDbHealth();
  ctx.status = dbOk ? 200 : 503;
  ctx.body = {
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
});

app.use(apiRouter.routes());
app.use(authRouter.routes());
app.use(authRouter.allowedMethods());
app.use(roomsRouter.routes());
app.use(roomsRouter.allowedMethods());

const messagesRouter = createMessagesRouter(wss);
app.use(messagesRouter.routes());
app.use(messagesRouter.allowedMethods());

// ─── Static Files ─────────────────────────────────────────────────────────────

const publicDir = path.join(__dirname, "../public");
app.use(serve(publicDir));

// SPA fallback: serve index.html for non-API routes
app.use(async (ctx) => {
  if (!ctx.path.startsWith("/api") && !ctx.path.startsWith("/ws")) {
    ctx.type = "html";
    ctx.body = Bun.file(path.join(publicDir, "index.html"));
  }
});

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(app.callback());

// WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/ws")) {
    wss.handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     💬 Messaging App                 ║
  ║     http://localhost:${PORT}            ║
  ║     ws://localhost:${PORT}/ws           ║
  ╚══════════════════════════════════════╝
  `);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = () => {
  console.log("\nShutting down gracefully...");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
