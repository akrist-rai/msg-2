import Router from "@koa/router";
import type { Context } from "koa";
import { checkDbHealth } from "../db/health";

const router = new Router();

router.get("/health", async (ctx: Context) => {
  const dbOk = await checkDbHealth();

  ctx.status = dbOk ? 200 : 503;
  ctx.body = {
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
});

export default router;