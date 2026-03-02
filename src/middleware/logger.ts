import type { Context, Next } from "koa";

export default async function logger(ctx: Context, next: Next) {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;

  console.log(`${ctx.method} ${ctx.path} ${ctx.status} - ${ms}ms`);
}