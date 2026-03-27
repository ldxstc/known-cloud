import { Hono } from "hono";

import { deleteNodesMatching, getDb } from "./db";
import type { AppEnv } from "./middleware";
import { authMiddleware } from "./middleware";

type ForgetBody = {
  what?: string;
};

export const forgetRoutes = new Hono<AppEnv>();
forgetRoutes.use("*", authMiddleware);

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
