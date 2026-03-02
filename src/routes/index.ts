import Router from "@koa/router";
import healthRouter from "./health";
import authRouter from "./auth";
import roomsRouter from "./rooms";
import { createMessagesRouter } from "./messages";
import type { WebSocketServer } from "ws";

export default function createApiRouter(wss: WebSocketServer) {
  const router = new Router({ prefix: "/api" });

  router.use(healthRouter.routes());
  router.use(authRouter.routes(), authRouter.allowedMethods());
  router.use(roomsRouter.routes(), roomsRouter.allowedMethods());

  const messagesRouter = createMessagesRouter(wss);
  router.use(messagesRouter.routes(), messagesRouter.allowedMethods());

  return router;
}