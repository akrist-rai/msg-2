import jwt from "jsonwebtoken";
import type { Context, Next } from "koa";
import { db, schema } from "../db/index.ts";
import { eq } from "drizzle-orm";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

export interface JWTPayload {
  userId: string;
  username: string;
  iat?: number;
  exp?: number;
}

export function signAccessToken(payload: Omit<JWTPayload, "iat" | "exp">): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "15m" });
}

export function signRefreshToken(payload: Omit<JWTPayload, "iat" | "exp">): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

// ─── Koa middleware ───────────────────────────────────────────────────────────

export async function requireAuth(ctx: Context, next: Next) {
  const authHeader = ctx.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.status = 401;
    ctx.body = { error: "Missing or invalid authorization header" };
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    
    // Attach user to context state
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, payload.userId),
      columns: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        avatarUrl: true,
        isOnline: true,
      },
    });

    if (!user) {
      ctx.status = 401;
      ctx.body = { error: "User not found" };
      return;
    }

    ctx.state.user = user;
    ctx.state.userId = user.id;
    await next();
  } catch (err) {
    ctx.status = 401;
    ctx.body = { error: "Invalid or expired token" };
  }
}

// Optional auth - attaches user if token present, doesn't fail if not
export async function optionalAuth(ctx: Context, next: Next) {
  const authHeader = ctx.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const token = authHeader.slice(7);
      const payload = verifyToken(token);
      ctx.state.user = await db.query.users.findFirst({
        where: eq(schema.users.id, payload.userId),
      });
      ctx.state.userId = ctx.state.user?.id;
    } catch {
      // Ignore errors, just don't attach user
    }
  }
  await next();
}
