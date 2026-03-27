import { Hono } from "hono";

import { deleteNodesMatching, getDb } from "./db";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import type { AppEnv } from "./types";

type ForgetBody = {
  what?: string;
};

export const forgetRoutes = new Hono<AppEnv>();
forgetRoutes.use("*", authMiddleware, rateLimitMiddleware, requireUserAuth);

forgetRoutes.delete("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as ForgetBody | null;
  const what = body?.what?.trim();

  if (!what) {
    return c.json({ error: "what is required" }, 400);
  }

  const db = await getDb(c.env);
  const deleted = await deleteNodesMatching(db, c.get("user").id, what);
  return c.json({ deleted });
});
