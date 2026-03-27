import { Hono } from "hono";

import {
  addInsightSupport,
  getDb,
  getUserInsights,
  insertInsight,
  markInsightInitiated,
  strengthenInsight,
  type InsightRow,
} from "./db";
import { decodeEmbedding, encodeEmbedding, generateEmbeddingVector, semanticSearch } from "./embeddings";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import type { AppEnv } from "./types";

const DEFAULT_INSIGHT_SIMILARITY_THRESHOLD = 0.6;
const INSIGHT_KEYWORD_MATCH_THRESHOLD = 3;
const INSIGHT_STOPWORDS = new Set([
  "ability",
  "about",
  "across",
  "actionable",
  "again",
  "after",
  "aligned",
  "aligns",
  "approach",
  "approaches",
  "behavior",
  "behavioral",
  "being",
  "clarity",
  "communication",
  "consistent",
  "consistency",
  "context",
  "contexts",
  "could",
  "decision",
  "demonstrate",
  "demonstrates",
  "domain",
  "domains",
  "efficiency",
  "focus",
  "focused",
  "focusing",
  "from",
  "holistic",
  "indicate",
  "indicates",
  "indicating",
  "insight",
  "making",
  "mirror",
  "mirrors",
  "pattern",
  "patterns",
  "people",
  "person",
  "personal",
  "preference",
  "preferences",
  "professional",
  "reflect",
  "reflects",
  "reveal",
  "reveals",
  "shows",
  "showing",
  "skills",
  "specific",
  "structure",
  "structured",
  "style",
  "suggest",
  "suggests",
  "their",
  "there",
  "these",
  "they",
  "thing",
  "think",
  "this",
  "that",
  "through",
  "unique",
  "with",
  "while",
  "which",
  "would",
]);

export interface StoreOrStrengthenInsightResult {
  created: boolean;
  strengthened: boolean;
  insightId: string;
}

export function shouldSurfaceInsight(insight: Pick<InsightRow, "times_rediscovered" | "confidence">) {
  return insight.times_rediscovered >= 2 && insight.confidence >= 0.6;
}

export function isInsightInitiatable(
  insight: Pick<InsightRow, "confidence" | "times_rediscovered" | "times_used" | "initiated_at">,
) {
  return insight.confidence >= 0.7 && insight.times_rediscovered >= 2 && insight.times_used === 0 && !insight.initiated_at;
}

function tokenizeInsightText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 4 && !INSIGHT_STOPWORDS.has(token));
}

function keywordOverlapCount(left: string, right: string) {
  const leftTokens = new Set(tokenizeInsightText(left));
  const rightTokens = new Set(tokenizeInsightText(right));
  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

export async function storeOrStrengthenInsight(
  env: AppEnv["Bindings"],
  userId: string,
  text: string,
  supportingNodeIds: string[],
  similarityThreshold: number = DEFAULT_INSIGHT_SIMILARITY_THRESHOLD,
) {
  const db = await getDb(env);
  const embeddingVector = await generateEmbeddingVector(env, text);
  const embedding = encodeEmbedding(embeddingVector);
  const allInsights = await getUserInsights(db, userId);
  const semanticCandidates = semanticSearch(embeddingVector, allInsights, allInsights.length);

  let matchedInsight:
    | (InsightRow & {
        score: number;
        keywordOverlap: number;
      })
    | undefined;

  for (const insight of allInsights) {
    const semanticMatch = semanticCandidates.find((candidate) => candidate.id === insight.id);
    const similarity = semanticMatch?.score ?? 0;
    const overlap = keywordOverlapCount(insight.text, text);
    if (similarity < similarityThreshold && overlap < INSIGHT_KEYWORD_MATCH_THRESHOLD) {
      continue;
    }

    const candidate = {
      ...insight,
      score: similarity,
      keywordOverlap: overlap,
    };

    if (
      !matchedInsight ||
      candidate.keywordOverlap > matchedInsight.keywordOverlap ||
      (candidate.keywordOverlap === matchedInsight.keywordOverlap && candidate.score > matchedInsight.score)
    ) {
      matchedInsight = candidate;
    }
  }

  if (matchedInsight) {
    const useNewerText = text.trim().length > matchedInsight.text.trim().length;
    const row = await strengthenInsight(db, matchedInsight.id, useNewerText ? { text, embedding } : undefined);
    await addInsightSupport(db, matchedInsight.id, supportingNodeIds);
    return {
      created: false,
      strengthened: true,
      insightId: row.id,
    } satisfies StoreOrStrengthenInsightResult;
  }

  const row = await insertInsight(db, {
    userId,
    text,
    supportingNodes: supportingNodeIds,
    confidence: 0.4,
    embedding,
  });

  return {
    created: true,
    strengthened: false,
    insightId: row.id,
  } satisfies StoreOrStrengthenInsightResult;
}

export const insightRoutes = new Hono<AppEnv>();
insightRoutes.use("*", authMiddleware, rateLimitMiddleware, requireUserAuth);

insightRoutes.get("/", async (c) => {
  const db = await getDb(c.env);
  const insights = await getUserInsights(db, c.get("user").id);

  for (const insight of insights) {
    if (isInsightInitiatable(insight)) {
      await markInsightInitiated(db, insight.id);
    }
  }

  const refreshed = await getUserInsights(db, c.get("user").id);
  return c.json({
    insights: refreshed.map((insight) => ({
      id: insight.id,
      text: insight.text,
      confidence: insight.confidence,
      times_rediscovered: insight.times_rediscovered,
      times_used: insight.times_used,
      initiated: Boolean(insight.initiated_at),
      initiatable: isInsightInitiatable(insight),
      initiated_at: insight.initiated_at,
      discovered_at: insight.discovered_at,
    })),
  });
});
