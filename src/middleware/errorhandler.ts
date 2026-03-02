// src/middleware/errorHandler.ts
import type { Context, Next } from "koa";

const isDev = process.env.NODE_ENV !== "production";

export default async function errorHandler(ctx: Context, next: Next) {
  try {
    await next();
  } catch (err: any) {
    const status = err.status || err.statusCode || 500;

    ctx.status = status;
    ctx.body = {
      error: status < 500 ? err.message : "Internal server error",
      ...(isDev && status >= 500 ? { stack: err.stack } : {}),
    };

    ctx.app.emit("error", err, ctx);
  }
}