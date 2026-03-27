import { Hono } from "hono";

import { getDb, getUserNodes } from "./db";
import { generateEmbeddingVector, semanticSearch } from "./embeddings";
import { ensureWithinLimit, recordUsage } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireScopes } from "./middleware";
import type { AppEnv } from "./types";

export const searchRoutes = new Hono<AppEnv>();
searchRoutes.use("*", authMiddleware, rateLimitMiddleware, requireScopes("search"));

searchRoutes.get("/", async (c) => {
  const query = c.req.query("q")?.trim();
  const limitParam = c.req.query("limit");
  const limit = Math.min(Math.max(Number(limitParam ?? "5") || 5, 1), 50);

  if (!query) {
    return c.json({ error: "q is required" }, 400);
  }

  const db = await getDb(c.env);
  const limitResponse = await ensureWithinLimit(c, db, "queries");
  if (limitResponse) {
    return limitResponse;
  }

  const nodes = await getUserNodes(db, c.get("user").id);
  if (nodes.length === 0) {
    await recordUsage(c, db, "queries");
    return c.json({ results: [] });
  }

  const queryVector = await generateEmbeddingVector(c.env, query);
  const results = semanticSearch(queryVector, nodes, limit).map((node) => ({
    node_id: node.id,
    text: node.text,
    specific_context: node.specific_context,
    confidence: node.confidence,
    type: node.type,
    score: node.score,
  }));

  await recordUsage(c, db, "queries");
  return c.json({ results });
});
