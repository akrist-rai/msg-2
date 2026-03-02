import Router from "@koa/router";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  requireAuth,
} from "../middleware/auth.ts";

export const authRouter = new Router({ prefix: "/api/auth" });

// ─── Validation schemas ───────────────────────────────────────────────────────

const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, _ and -"),
  displayName: z.string().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

// ─── Register ─────────────────────────────────────────────────────────────────

authRouter.post("/register", async (ctx) => {
  try {
    const result = registerSchema.safeParse(ctx.request.body);
    if (!result.success) {
      ctx.status = 400;
      ctx.body = { error: "Validation failed", details: result.error.flatten() };
      return;
    }

    const { username, displayName, email, password } = result.data;

    // Check uniqueness
    const existing = await db.query.users.findFirst({
      where: eq(schema.users.username, username.toLowerCase()),
    });

    if (existing) {
      ctx.status = 409;
      ctx.body = { error: "Username already taken" };
      return;
    }

    const existingEmail = await db.query.users.findFirst({
      where: eq(schema.users.email, email.toLowerCase()),
    });

    if (existingEmail) {
      ctx.status = 409;
      ctx.body = { error: "Email already registered" };
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [user] = await db
      .insert(schema.users)
      .values({
        username: username.toLowerCase(),
        displayName,
        email: email.toLowerCase(),
        passwordHash,
      })
      .returning({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        email: schema.users.email,
      });

    if (!user) {
      ctx.status = 500;
      ctx.body = { error: "Failed to create user" };
      return;
    }

    const accessToken = signAccessToken({ userId: user.id, username: user.username });
    const refreshToken = signRefreshToken({ userId: user.id, username: user.username });

    // Store refresh token
    await db.insert(schema.refreshTokens).values({
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    ctx.status = 201;
    ctx.body = {
      user,
      accessToken,
      refreshToken,
    };
  } catch (err: any) {
    console.error("Registration error:", err);
    ctx.status = 500;
    ctx.body = {
      error:
        process.env.NODE_ENV !== "production" && err?.message
          ? err.message
          : "Internal server error",
    };
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

authRouter.post("/login", async (ctx) => {
  const result = loginSchema.safeParse(ctx.request.body);
  if (!result.success) {
    ctx.status = 400;
    ctx.body = { error: "Validation failed" };
    return;
  }

  const { username, password } = result.data;

  const user = await db.query.users.findFirst({
    where: eq(schema.users.username, username.toLowerCase()),
  });

  if (!user) {
    ctx.status = 401;
    ctx.body = { error: "Invalid credentials" };
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    ctx.status = 401;
    ctx.body = { error: "Invalid credentials" };
    return;
  }

  // Update online status
  await db
    .update(schema.users)
    .set({ isOnline: true, lastSeen: new Date() })
    .where(eq(schema.users.id, user.id));

  const accessToken = signAccessToken({ userId: user.id, username: user.username });
  const refreshToken = signRefreshToken({ userId: user.id, username: user.username });

  await db.insert(schema.refreshTokens).values({
    userId: user.id,
    token: refreshToken,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  ctx.body = {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
    },
    accessToken,
    refreshToken,
  };
});

// ─── Refresh Token ────────────────────────────────────────────────────────────

authRouter.post("/refresh", async (ctx) => {
  const { refreshToken } = (ctx.request.body as any) || {};
  if (!refreshToken) {
    ctx.status = 400;
    ctx.body = { error: "Refresh token required" };
    return;
  }

  try {
    const payload = verifyToken(refreshToken);

    const storedToken = await db.query.refreshTokens.findFirst({
      where: and(
        eq(schema.refreshTokens.token, refreshToken),
        gt(schema.refreshTokens.expiresAt, new Date())
      ),
    });

    if (!storedToken) {
      ctx.status = 401;
      ctx.body = { error: "Invalid refresh token" };
      return;
    }

    // Rotate the refresh token
    await db
      .delete(schema.refreshTokens)
      .where(eq(schema.refreshTokens.token, refreshToken));

    const newAccessToken = signAccessToken({ userId: payload.userId, username: payload.username });
    const newRefreshToken = signRefreshToken({ userId: payload.userId, username: payload.username });

    await db.insert(schema.refreshTokens).values({
      userId: payload.userId,
      token: newRefreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    ctx.body = { accessToken: newAccessToken, refreshToken: newRefreshToken };
  } catch {
    ctx.status = 401;
    ctx.body = { error: "Invalid refresh token" };
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────

authRouter.post("/logout", requireAuth, async (ctx) => {
  const { refreshToken } = (ctx.request.body as any) || {};

  if (refreshToken) {
    await db
      .delete(schema.refreshTokens)
      .where(eq(schema.refreshTokens.token, refreshToken));
  }

  // Mark offline
  await db
    .update(schema.users)
    .set({ isOnline: false, lastSeen: new Date() })
    .where(eq(schema.users.id, ctx.state.userId));

  ctx.body = { success: true };
});

// ─── Me ───────────────────────────────────────────────────────────────────────

authRouter.get("/me", requireAuth, async (ctx) => {
  ctx.body = { user: ctx.state.user };
});

// ─── Update profile ───────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  bio: z.string().max(256).optional(),
  avatarUrl: z.string().url().optional(),
});

authRouter.patch("/me", requireAuth, async (ctx) => {
  const result = updateProfileSchema.safeParse(ctx.request.body);
  if (!result.success) {
    ctx.status = 400;
    ctx.body = { error: "Validation failed", details: result.error.flatten() };
    return;
  }

  const [updated] = await db
    .update(schema.users)
    .set({ ...result.data, updatedAt: new Date() })
    .where(eq(schema.users.id, ctx.state.userId))
    .returning({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
      bio: schema.users.bio,
    });

  ctx.body = { user: updated };
});
