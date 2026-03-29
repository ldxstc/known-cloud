import { Hono } from "hono";

import {
  findUserNodeByTextPrefix, findUserNodeByTypeAndText,
  getDb,
  getUserNodes,
  insertMessage,
  insertNode,
  penalizeNodeConfidence,
  updateNodeObservation,
  countUserNodes,
  type NodeRow,
} from "./db";
import { generateEmbeddingBlob, generateEmbeddingBlobs, decodeEmbedding, semanticSearch } from "./embeddings";
import { recordUsage, ensureWithinLimit } from "./limits";
import type { AppEnv } from "./types";
import { createJsonCompletion, EXTRACTION_MODEL } from "./openai";
import {
  CONTRADICTION_SYSTEM,
  CONTRADICTION_USER,
  INGEST_FACT_SYSTEM,
  INGEST_FACT_USER,
  INGEST_SYSTEM,
  INGEST_USER,
} from "./prompts";
import { authMiddleware, rateLimitMiddleware, requireScopes } from "./middleware";

type ExtractedNode = {
  text?: string;
  type?: string;
  specific_context?: string;
  files_touched?: string[];
};

type ExtractionResult = {
  nodes?: ExtractedNode[];
};

type IngestBody = {
  text?: string;
  session_id?: string;
  source?: string;
  wait?: boolean;
};

const FACT_TYPE_PREFIX = "fact:";
const DEDUP_SIMILARITY_THRESHOLD = 0.8;
const MAX_CONTRADICTION_CHECKS = 3;
const MAX_CHUNK_CHARS = 30000;
const LARGE_BLOCK_THRESHOLD = 10000;
const RAW_MESSAGE_CHUNK_CHARS = 5000;
const FILE_REGEX = /(?:~\/|\.\/|\/[\w-]+\/|[\w-]+\/)[\w./-]+\.\w{1,10}/g;

function normalizeNodeType(type?: string) {
  const trimmed = type?.trim().toLowerCase() ?? "";
  const isFact = trimmed.startsWith(FACT_TYPE_PREFIX);
  const rawType = isFact ? trimmed.slice(FACT_TYPE_PREFIX.length) : trimmed;
  const normalized = rawType.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  if (isFact) {
    return `${FACT_TYPE_PREFIX}${normalized || "detail"}`;
  }

  return normalized || "trait";
}

function choosePreferredNodeType(existingType: string, incomingType: string) {
  const existingIsFact = existingType.startsWith(FACT_TYPE_PREFIX);
  const incomingIsFact = incomingType.startsWith(FACT_TYPE_PREFIX);

  if (incomingIsFact && !existingIsFact) {
    return incomingType;
  }

  const generic = new Set(["trait", `${FACT_TYPE_PREFIX}detail`]);
  if (!generic.has(incomingType) && generic.has(existingType)) {
    return incomingType;
  }

  return existingType;
}

function mergeSpecificContext(existing?: string | null, incoming?: string | null) {
  const parts = [existing, incoming]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return parts.length > 0 ? [...new Set(parts)].join(" | ") : null;
}

function mergeFilesTouched(existing?: string[] | null, incoming?: string[] | null) {
  const merged = [...new Set([...(existing ?? []), ...(incoming ?? [])].map((value) => value.trim()).filter(Boolean))];
  return merged.length > 0 ? merged : null;
}

function parseFilesTouched(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as string[];
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : null;
  } catch {
    return null;
  }
}

function extractFilesTouched(sessionText: string) {
  return [...new Set(sessionText.match(FILE_REGEX) ?? [])];
}

function parseExtraction(content: string): ExtractionResult {
  try {
    const parsed = JSON.parse(content) as ExtractionResult;
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    };
  } catch {
    return { nodes: [] };
  }
}

function dedupeNodes(nodes: ExtractedNode[]) {
  const deduped = new Map<string, { text: string; type: string; specific_context: string | null; files_touched: string[] | null }>();

  for (const node of nodes) {
    const text = node.text?.trim();
    if (!text) {
      continue;
    }

    const key = text.toLowerCase();
    const type = normalizeNodeType(node.type);
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, {
        text,
        type,
        specific_context: node.specific_context?.trim() || null,
        files_touched: node.files_touched?.length ? [...new Set(node.files_touched)] : null,
      });
      continue;
    }

    deduped.set(key, {
      text,
      type: choosePreferredNodeType(existing.type, type),
      specific_context: mergeSpecificContext(existing.specific_context, node.specific_context ?? null),
      files_touched: mergeFilesTouched(existing.files_touched, node.files_touched ?? null),
    });
  }

  return [...deduped.values()];
}

function chunkText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxChars) {
    chunks.push(text.slice(start, start + maxChars));
  }
  return chunks;
}

function buildChunkSource(source: string | null, sessionId: string | null, index: number, total: number) {
  const base = source ?? sessionId ?? "ingest";
  return `${base}#chunk:${index + 1}/${total}`;
}

function tagFactNodes(nodes: ExtractedNode[]) {
  return nodes.map((node) => ({
    ...node,
    type: `${FACT_TYPE_PREFIX}${node.type?.trim() || "detail"}`,
  }));
}

async function judgeObservationRelationship(env: AppEnv["Bindings"], existing: string, candidate: string) {
  const { content } = await createJsonCompletion(env, {
    model: EXTRACTION_MODEL,
    systemPrompt: CONTRADICTION_SYSTEM,
    prompt: CONTRADICTION_USER(existing, candidate),
    temperature: 0,
  });

  try {
    const parsed = JSON.parse(content) as { relation?: "same" | "contradict" | "different" };
    return parsed.relation === "same" || parsed.relation === "contradict" ? parsed.relation : "different";
  } catch {
    return "different";
  }
}

async function resolveNodeStorage(
  env: AppEnv["Bindings"],
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  node: { text: string; type: string; specific_context: string | null; files_touched: string[] | null },
  embedding: ArrayBuffer,
  source: string | null,
  existingNodes: NodeRow[],
) {
  const exact = await findUserNodeByTypeAndText(db, userId, node.type, node.text);

  if (exact) {
    const mergedFiles = mergeFilesTouched(parseFilesTouched(exact.files_touched), node.files_touched);
    const updated = await updateNodeObservation(db, exact.id, {
      confidence: Math.min(1, exact.confidence + 0.05),
      embedding,
      filesTouched: mergedFiles ? JSON.stringify(mergedFiles) : null,
      source,
      specificContext: mergeSpecificContext(exact.specific_context, node.specific_context),
      type: choosePreferredNodeType(exact.type, node.type),
      updatedAt: new Date().toISOString(),
    });

    return { created: false, row: updated };
  }

  const queryVector = decodeEmbedding(embedding);
  if (queryVector) {
    const similar = semanticSearch(queryVector, existingNodes, MAX_CONTRADICTION_CHECKS).filter(
      (candidate) => candidate.score >= DEDUP_SIMILARITY_THRESHOLD,
    );

    for (const candidate of similar) {
      const relation = await judgeObservationRelationship(env, candidate.text, node.text);

      if (relation === "same") {
        const mergedFiles = mergeFilesTouched(parseFilesTouched(candidate.files_touched), node.files_touched);
        const updated = await updateNodeObservation(db, candidate.id, {
          confidence: Math.min(1, candidate.confidence + 0.05),
          embedding,
          filesTouched: mergedFiles ? JSON.stringify(mergedFiles) : null,
          source,
          specificContext: mergeSpecificContext(candidate.specific_context, node.specific_context),
          type: choosePreferredNodeType(candidate.type, node.type),
          updatedAt: new Date().toISOString(),
        });

        return { created: false, row: updated };
      }

      if (relation === "contradict") {
        await penalizeNodeConfidence(db, candidate.id, 0.7);
      }
    }
  }

  const createdAt = new Date().toISOString();
  const inserted = await insertNode(db, {
    confidence: 1,
    createdAt,
    embedding,
    filesTouched: node.files_touched ? JSON.stringify(node.files_touched) : null,
    source,
    specificContext: node.specific_context,
    text: node.text,
    type: node.type,
    updatedAt: createdAt,
    userId,
  });

  return { created: true, row: inserted };
}

export const ingestRoutes = new Hono<AppEnv>();
ingestRoutes.use("*", authMiddleware, rateLimitMiddleware, requireScopes("ingest"));

ingestRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as IngestBody | null;
  const text = body?.text?.trim();
  // `wait` is accepted for API compatibility. Ingest already processes synchronously before returning.

  if (!text) {
    return c.json({ error: "text is required" }, 400);
  }

  const db = await getDb(c.env);
  const limitResponse = await ensureWithinLimit(c, db, "ingestions");
  if (limitResponse) {
    return limitResponse;
  }

  const source = body?.source?.trim() || body?.session_id?.trim() || null;
  const sessionId = body?.session_id?.trim() || (source && !source.startsWith("file:") ? source : null);
  const createdAt = new Date().toISOString();
  await insertMessage(db, {
    userId: c.get("user").id,
    sessionId,
    source,
    text,
    createdAt,
  });

  if (text.length > LARGE_BLOCK_THRESHOLD) {
    const rawChunks = chunkText(text, RAW_MESSAGE_CHUNK_CHARS);
    for (const [index, rawChunk] of rawChunks.entries()) {
      await insertMessage(db, {
        userId: c.get("user").id,
        sessionId,
        source: buildChunkSource(source, sessionId, index, rawChunks.length),
        text: rawChunk,
        createdAt,
      });
    }
  }

  const extractionText = text.length > LARGE_BLOCK_THRESHOLD ? text.slice(0, MAX_CHUNK_CHARS) : text;
  const chunks = chunkText(extractionText, MAX_CHUNK_CHARS);
  const filesTouched = extractFilesTouched(text);
  let nodesCreated = 0;
  let nodesUpdated = 0;

  for (const [index, chunk] of chunks.entries()) {
    const [{ content: patternContent }, { content: factContent }] = await Promise.all([
      createJsonCompletion(c.env, {
        model: EXTRACTION_MODEL,
        systemPrompt: INGEST_SYSTEM,
        prompt: INGEST_USER(chunk),
        temperature: 0.1,
      }),
      createJsonCompletion(c.env, {
        model: EXTRACTION_MODEL,
        systemPrompt: INGEST_FACT_SYSTEM,
        prompt: INGEST_FACT_USER(chunk),
        temperature: 0.1,
      }),
    ]);

    const patternNodes = parseExtraction(patternContent).nodes ?? [];
    const factNodes = tagFactNodes(parseExtraction(factContent).nodes ?? []);
    const nodes = dedupeNodes([...patternNodes, ...factNodes]);

    if (nodes.length === 0) {
      continue;
    }

    if (index === 0 && filesTouched.length > 0) {
      const first = nodes[0];
      if (first) {
        first.files_touched = mergeFilesTouched(first.files_touched, filesTouched);
      }
    }

    const embeddings = await generateEmbeddingBlobs(
      c.env,
      nodes.map((node) => node.text),
    );
    let existingNodes = await getUserNodes(db, c.get("user").id);

    for (const [nodeIndex, node] of nodes.entries()) {
      const embedding = embeddings[nodeIndex];
      if (!embedding) {
        continue;
      }

      const result = await resolveNodeStorage(c.env, db, c.get("user").id, node, embedding, source, existingNodes);
      if (result.created) {
        nodesCreated += 1;
        existingNodes = [result.row, ...existingNodes];
      } else {
        nodesUpdated += 1;
        existingNodes = existingNodes.map((candidate) => (candidate.id === result.row.id ? result.row : candidate));
      }
    }
  }

  // For file sources: also store raw paragraphs as verbatim nodes
  // This preserves exact text (URLs, API keys, dates, numbers) that LLM extraction may normalize
  if (source && source.startsWith("file:")) {
    const paragraphs = text.split(/\n\n+/).filter((p: string) => p.trim().length > 20);
    for (const para of paragraphs.slice(0, 30)) {  // limit to 30 paragraphs
      const trimmed = para.trim().slice(0, 500);  // cap length
      const existing = await findUserNodeByTextPrefix(db, c.get("user").id, trimmed.slice(0, 80));
      if (!existing) {
        const embedding = await generateEmbeddingBlob(c.env, trimmed);
        await insertNode(db, {
          userId: c.get("user").id,
          type: "verbatim:" + source,
          text: trimmed,
          specificContext: trimmed,
          confidence: 0.9,
          source: source,
          embedding: embedding,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          timesObserved: 1,
        });
        nodesCreated += 1;
      }
    }
  }

  await recordUsage(c, db, "ingestions");
  const totalNodes = await countUserNodes(db, c.get("user").id);

  return c.json({
    nodes_created: nodesCreated,
    nodes_updated: nodesUpdated,
    total_nodes: totalNodes,
  });
});
