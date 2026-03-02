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


import createApiRouter from "./routes";
import { WebSocketServer } from "ws";


//seting up middleware
import corsMiddleware from "./middleware/cors";
import errorHandler from "./middleware/errorhandler.ts";
import bodyParser from "./middleware/bodyParser";
import logger from "./middleware/logger";
import rateLimit from "./middleware/rateLimit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isDev = process.env.NODE_ENV !== "production";

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = new Koa();

// Trust proxy headers (e.g. X-Forwarded-For)
app.proxy = true;

// ─── middleware ───────────────────────────────────────────────────────────

app.use(errorHandler);
app.use(corsMiddleware);
app.use(bodyParser);
// Request logging in dev
if (isDev) {
  app.use(logger);
}
app.use(rateLimit);
// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer();

// ─── Routes ───────────────────────────────────────────────────────────────────

const apiRouter = createApiRouter(wss);
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());

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
  
  Server is running on:               
      http://localhost:${PORT}            
      ws://localhost:${PORT}/ws          

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
