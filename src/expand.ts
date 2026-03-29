import { Hono } from "hono";

import { findMessagesBySessionOrSource, findUserNodeById, getDb } from "./db";
import { ensureWithinLimit, recordUsage } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireScopes } from "./middleware";
import type { AppEnv } from "./types";

export const expandRoutes = new Hono<AppEnv>();
expandRoutes.use("*", authMiddleware, rateLimitMiddleware, requireScopes("search"));

expandRoutes.get("/", async (c) => {
  const nodeId = c.req.query("node_id")?.trim();
  if (!nodeId) {
    return c.json({ error: "node_id is required" }, 400);
  }

  const db = await getDb(c.env);
  const limitResponse = await ensureWithinLimit(c, db, "queries");
  if (limitResponse) {
    return limitResponse;
  }

  const node = await findUserNodeById(db, c.get("user").id, nodeId);
  if (!node) {
    await recordUsage(c, db, "queries");
    return c.json({ error: "node_not_found" }, 404);
  }

  if (!node.source) {
    await recordUsage(c, db, "queries");
    return c.json({ error: "node_source_unavailable", node_id: node.id }, 404);
  }

  const messages = await findMessagesBySessionOrSource(db, c.get("user").id, node.source, 1);
  await recordUsage(c, db, "queries");

  if (messages.length === 0) {
    return c.json({ error: "source_message_not_found", node_id: node.id, source: node.source }, 404);
  }

  const message = messages[0];
  return c.json({
    node_id: node.id,
    message_id: message.id,
    source: message.source,
    session_id: message.session_id,
    created_at: message.created_at,
    text: message.text,
  });
});
