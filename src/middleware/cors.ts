import cors from "@koa/cors";
import type { Context } from "koa";

/*const allowed =
  process.env.ALLOWED_ORIGINS?.split(",") || [
    "http://localhost:3000",
    "http://localhost:5173",
  ];

export default cors({
  origin: (ctx: Context) => {
    const requestOrigin = ctx.request.headers.origin || "";
    return allowed.includes(requestOrigin)
      ? requestOrigin
      : allowed[0];
  },
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}); */

export default cors({
  origin: (ctx) => {
    const allowed =
      process.env.ALLOWED_ORIGINS?.split(",") ?? [];

    const origin = ctx.request.header.origin;

    if (!origin) return "";
    if (allowed.includes(origin)) return origin;

    return allowed[0] ?? "";
  },
  credentials: true,
});