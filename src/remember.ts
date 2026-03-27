import { Hono } from "hono";

import { findUserNodeByTypeAndText, getDb, insertNode, updateNodeObservation } from "./db";
import { generateEmbeddingBlob } from "./embeddings";
import { ensureWithinLimit, recordUsage } from "./limits";
import type { AppEnv } from "./middleware";
import { authMiddleware } from "./middleware";

type RememberBody = {
  what?: string;
  importance?: "high" | "medium" | "low";
};

export const rememberRoutes = new Hono<AppEnv>();
rememberRoutes.use("*", authMiddleware);

rememberRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as RememberBody | null;
  const what = body?.what?.trim();

  if (!what) {
    return c.json({ error: "what is required" }, 400);
  }

  const db = await getDb(c.env);
  const limitResponse = await ensureWithinLimit(c, db, "ingestions");
  if (limitResponse) {
    return limitResponse;
  }

  const type = "fact:manual";
  const specificContext = body?.importance ? `importance: ${body.importance}` : null;
  const embedding = await generateEmbeddingBlob(c.env, what);
  const existing = await findUserNodeByTypeAndText(db, c.get("user").id, type, what);

  const node = existing
    ? await updateNodeObservation(db, existing.id, {
        confidence: 1,
        embedding,
        source: "remember",
        specificContext,
        updatedAt: new Date().toISOString(),
      })
    : await insertNode(db, {
        confidence: 1,
        createdAt: new Date().toISOString(),
        embedding,
        source: "remember",
        specificContext,
        text: what,
        type,
        userId: c.get("user").id,
      });

  await recordUsage(c, db, "ingestions");

  return c.json({
    node_id: node.id,
    text: node.text,
    confidence: 1,
  });
});
