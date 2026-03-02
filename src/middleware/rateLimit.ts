
import type { Context, Next } from "koa";

const rateLimitMap = new Map<
  string,
  { count: number; resetAt: number }
>();

const windowMs = 15 * 60 * 1000; // 15 minutes
const maxRequests = 20;

export default async function rateLimit(
  ctx: Context,
  next: Next
) {
  // Only apply to auth routes
  if (!ctx.path.startsWith("/api/auth")) {
    return next();
  }

  const ip = ctx.ip || "unknown";
  const now = Date.now();

  let entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > maxRequests) {
    ctx.status = 429;
    ctx.body = {
      error: "Too many requests, please try again later",
    };
    return;
  }

  ctx.set("X-RateLimit-Limit", String(maxRequests));
  ctx.set(
    "X-RateLimit-Remaining",
    String(Math.max(0, maxRequests - entry.count))
  );

  await next();
}