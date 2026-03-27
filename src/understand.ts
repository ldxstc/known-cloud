import { Hono } from "hono";

import { getDb, getUserInsights, getUserNodes, markInsightsUsed } from "./db";
import { generateEmbeddingVector, semanticSearch } from "./embeddings";
import { ensureWithinLimit, recordUsage } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireScopes } from "./middleware";
import { createJsonCompletion, SYNTHESIS_MODEL } from "./openai";
import { THINK_SYSTEM, THINK_USER } from "./prompts";
import { shouldSurfaceInsight, storeOrStrengthenInsight } from "./insights";
import type { AppEnv } from "./types";

type ThinkResult = {
  response?: string;
  new_connections?: Array<{
    text?: string;
    supporting_node_ids?: string[];
  }>;
};

function parseThinkResult(content: string): ThinkResult {
  try {
    return JSON.parse(content) as ThinkResult;
  } catch {
    return { response: content, new_connections: [] };
  }
}

function computeActivation(similarity: number, confidence: number, timesObserved: number) {
  const weight = 1 + Math.min(Math.max(timesObserved, 1), 5) * 0.05;
  return similarity * Math.max(confidence, 0.1) * weight;
}

export const understandRoutes = new Hono<AppEnv>();
understandRoutes.use("*", authMiddleware, rateLimitMiddleware, requireScopes("understand"));

understandRoutes.get("/", async (c) => {
  const question = c.req.query("q")?.trim();
  if (!question) {
    return c.json({ error: "q is required" }, 400);
  }

  const db = await getDb(c.env);
  const limitResponse = await ensureWithinLimit(c, db, "queries");
  if (limitResponse) {
    return limitResponse;
  }

  const [nodes, insights] = await Promise.all([
    getUserNodes(db, c.get("user").id),
    getUserInsights(db, c.get("user").id),
  ]);

  if (nodes.length === 0) {
    await recordUsage(c, db, "queries");
    return c.json({
      context: "",
      nodes_used: 0,
      insights_used: 0,
      new_insights_cached: 0,
      tokens: 0,
    });
  }

  const queryVector = await generateEmbeddingVector(c.env, question);
  const relevantNodes = nodes.length <= 30 ? nodes.map((node) => ({ ...node, score: 1 })) : semanticSearch(queryVector, nodes, 20);
  const activatedNodes = relevantNodes
    .map((node) => ({
      ...node,
      activation: computeActivation(node.score, node.confidence, node.times_observed),
    }))
    .sort((left, right) => right.activation - left.activation)
    .slice(0, 25);

  const surfacedInsights = insights.length === 0
    ? []
    : semanticSearch(queryVector, insights, 10).filter((insight) => shouldSurfaceInsight(insight)).slice(0, 5);
  const knownPatterns = insights
    .filter((insight) => !surfacedInsights.some((candidate) => candidate.id === insight.id))
    .sort((left, right) => right.confidence - left.confidence || right.times_rediscovered - left.times_rediscovered)
    .slice(0, 3);

  const prompt = THINK_USER(
    question,
    activatedNodes.map((node) => ({
      id: node.id,
      type: node.type,
      text: node.text,
      confidence: node.confidence,
      similarity: node.score,
      activation: node.activation,
      times_observed: node.times_observed,
    })),
    [],
    surfacedInsights.map((insight) => ({
      id: insight.id,
      text: insight.text,
      confidence: insight.confidence,
      times_rediscovered: insight.times_rediscovered,
      times_used: insight.times_used,
    })),
    knownPatterns.map((insight) => ({
      id: insight.id,
      text: insight.text,
      confidence: insight.confidence,
      times_rediscovered: insight.times_rediscovered,
      times_used: insight.times_used,
    })),
  );

  const { content, usage } = await createJsonCompletion(c.env, {
    model: SYNTHESIS_MODEL,
    systemPrompt: THINK_SYSTEM,
    prompt,
    temperature: 0.4,
  });
  const result = parseThinkResult(content);

  const insightIdsUsed = [...new Set([...surfacedInsights, ...knownPatterns].map((insight) => insight.id))];
  if (insightIdsUsed.length > 0) {
    await markInsightsUsed(db, insightIdsUsed, new Date().toISOString());
  }

  let newInsights = 0;
  for (const connection of result.new_connections ?? []) {
    const text = connection.text?.trim();
    if (!text) {
      continue;
    }

    const supportingNodeIds = (connection.supporting_node_ids ?? []).filter((nodeId) =>
      activatedNodes.some((node) => node.id === nodeId),
    );

    const stored = await storeOrStrengthenInsight(c.env, c.get("user").id, text, supportingNodeIds, 0.6);
    if (stored.created) {
      newInsights += 1;
    }
  }

  await recordUsage(c, db, "queries");

  return c.json({
    context: result.response ?? "",
    nodes_used: activatedNodes.length,
    insights_used: insightIdsUsed.length,
    new_insights_cached: newInsights,
    tokens: usage?.total_tokens ?? 0,
  });
});
