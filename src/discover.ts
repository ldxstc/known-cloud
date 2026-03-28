import { Hono } from "hono";

import {
  getDb,
  getDistinctUserNodeTypes,
  getUserNodesByType,
  type NodeRow,
} from "./db";
import { cosineSimilarity, decodeEmbedding } from "./embeddings";
import { ensureWithinLimit, recordUsage } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import { createJsonCompletion, SYNTHESIS_MODEL } from "./openai";
import { DISCOVER_SYSTEM, DISCOVER_USER } from "./prompts";
import { storeOrStrengthenInsight } from "./insights";
import type { AppEnv } from "./types";

type DiscoverResult = {
  found?: boolean;
  insight?: string;
  supporting_node_ids?: string[];
};

function averageEmbedding(nodes: NodeRow[]) {
  const vectors = nodes
    .map((node) => decodeEmbedding(node.embedding))
    .filter((vector): vector is Float32Array => Boolean(vector));

  if (vectors.length === 0) {
    return null;
  }

  const dimension = vectors[0]!.length;
  const average = new Float32Array(dimension);

  for (const vector of vectors) {
    for (let index = 0; index < dimension; index += 1) {
      average[index] += vector[index]!;
    }
  }

  for (let index = 0; index < dimension; index += 1) {
    average[index] /= vectors.length;
  }

  return average;
}

async function maximallyDistantClusters(env: AppEnv["Bindings"], userId: string, clusterSize: number = 5) {
  const db = await getDb(env);

  // SINGLE query: fetch all nodes with embeddings at once (avoids N+1 Turso subrequests)
  const allNodesResult = await db.execute({
    sql: "SELECT id, type, text, confidence, specific_context, embedding FROM nodes WHERE user_id = ? AND embedding IS NOT NULL ORDER BY confidence DESC LIMIT 120",
    args: [userId],
  });

  // Group by type in JS — zero additional DB calls
  const byType = new Map<string, NodeRow[]>();
  for (const row of allNodesResult.rows) {
    const node = row as unknown as NodeRow;
    if (!byType.has(node.type)) byType.set(node.type, []);
    const arr = byType.get(node.type)!;
    if (arr.length < 3) arr.push(node);
  }

  const entries = [];
  for (const [category, nodes] of byType.entries()) {
    if (nodes.length < 3) continue;
    const centroid = averageEmbedding(nodes);
    if (!centroid) continue;
    entries.push({ category, nodes, centroid });
  }

  if (entries.length < 2) {
    return null;
  }

  const pairs: Array<{
    categoryA: string;
    categoryB: string;
    clusterA: NodeRow[];
    clusterB: NodeRow[];
    distance: number;
  }> = [];

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex]!;
      const right = entries[rightIndex]!;
      const similarity = cosineSimilarity(left.centroid, right.centroid);

      pairs.push({
        categoryA: left.category,
        categoryB: right.category,
        clusterA: left.nodes,
        clusterB: right.nodes,
        distance: 1 - similarity,
      });
    }
  }

  if (pairs.length === 0) {
    return null;
  }

  pairs.sort((left, right) => right.distance - left.distance);
  const topCount = Math.max(1, Math.floor(pairs.length * 0.2));
  const topPairs = pairs.slice(0, topCount);
  return topPairs[Math.floor(Math.random() * topPairs.length)] ?? null;
}

function parseDiscoverResult(content: string) {
  try {
    return JSON.parse(content) as DiscoverResult;
  } catch {
    return { found: false };
  }
}

export const discoverRoutes = new Hono<AppEnv>();
discoverRoutes.use("*", authMiddleware, rateLimitMiddleware, requireUserAuth);

discoverRoutes.post("/", async (c) => {
  const db = await getDb(c.env);
  const limitResponse = await ensureWithinLimit(c, db, "queries");
  if (limitResponse) {
    return limitResponse;
  }

  const pair = await maximallyDistantClusters(c.env, c.get("user").id, 5);
  if (!pair || pair.clusterA.length < 3 || pair.clusterB.length < 3) {
    await recordUsage(c, db, "queries");
    return c.json({ insight: null });
  }

  const { content } = await createJsonCompletion(c.env, {
    model: SYNTHESIS_MODEL,
    systemPrompt: DISCOVER_SYSTEM,
    prompt: DISCOVER_USER(
      pair.clusterA.map((node) => ({ id: node.id, type: node.type, text: node.text })),
      pair.clusterB.map((node) => ({ id: node.id, type: node.type, text: node.text })),
      pair.categoryA,
      pair.categoryB,
    ),
    temperature: 0.5,
  });

  const result = parseDiscoverResult(content);
  const insight = result.insight?.trim();
  if (!result.found || !insight) {
    await recordUsage(c, db, "queries");
    return c.json({ insight: null });
  }

  const supportingNodeIds =
    result.supporting_node_ids?.filter(
      (nodeId) => pair.clusterA.some((node) => node.id === nodeId) || pair.clusterB.some((node) => node.id === nodeId),
    ) ?? [...pair.clusterA.map((node) => node.id), ...pair.clusterB.map((node) => node.id)];

  const { content: judgedContent } = await createJsonCompletion(c.env, {
    model: SYNTHESIS_MODEL,
    systemPrompt: `You harshly grade candidate behavioral insights about a specific person.

Rate the insight from 1 to 5:
1 = Generic platitude, could describe almost anyone
2 = Somewhat specific but not actionable
3 = Specific to this person and moderately useful
4 = Specific, actionable, and reveals a non-obvious pattern
5 = Profound behavioral insight that could materially change how this person works

Return valid JSON only:
{
  "score": 4
}`,
    prompt: JSON.stringify({
      insight,
      clusterA: pair.clusterA.map((node) => ({ id: node.id, type: node.type, text: node.text })),
      clusterB: pair.clusterB.map((node) => ({ id: node.id, type: node.type, text: node.text })),
    }),
    temperature: 0,
  });

  let score = 0;
  try {
    score = (JSON.parse(judgedContent) as { score?: number }).score ?? 0;
  } catch {
    score = 0;
  }

  if (score < 3) {
    await recordUsage(c, db, "queries");
    return c.json({ insight: null });
  }

  const stored = await storeOrStrengthenInsight(c.env, c.get("user").id, insight, supportingNodeIds, 0.6);
  await recordUsage(c, db, "queries");

  return c.json({
    insight,
    confidence: stored.created ? 0.4 : 0.5,
    is_new: stored.created,
  });
});
