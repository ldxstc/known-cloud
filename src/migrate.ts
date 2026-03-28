import { Hono } from "hono";
import initSqlJs from "sql.js";

import { getDb, getUserInsights, getUserNodes, insertInsight, insertNode, updateNodeObservation, upsertInsight, findUserNodeByTypeAndText, countUserNodes } from "./db";
import { createInsightId, createNodeId } from "./ids";
import { encodeEmbedding } from "./embeddings";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import type { AppEnv } from "./types";
import { parseJsonArray } from "./utils";

type ExportPayload = {
  nodes?: Array<Record<string, unknown>>;
  insights?: Array<Record<string, unknown>>;
};

let sqlJsPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;
const SQL_WASM_URL = "https://sql.js.org/dist/sql-wasm.wasm";

function copyArrayBuffer(buffer: ArrayBuffer) {
  return buffer.slice(0);
}

function isLikelyBase64Blob(value: Uint8Array) {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }

  for (const byte of value) {
    const isBase64Char =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2b ||
      byte === 0x2f ||
      byte === 0x3d;

    if (!isBase64Char) {
      return false;
    }
  }

  return true;
}

function normalizeImportedEmbedding(value: unknown): ArrayBuffer | null {
  if (value instanceof Uint8Array) {
    if (isLikelyBase64Blob(value)) {
      return copyArrayBuffer(Uint8Array.from(value).buffer);
    }

    if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      return null;
    }

    const copied = Uint8Array.from(value).buffer;
    return encodeEmbedding(new Float32Array(copied));
  }

  if (value instanceof ArrayBuffer) {
    return normalizeImportedEmbedding(new Uint8Array(value));
  }

  if (typeof value === "string" && value.length > 0) {
    return new TextEncoder().encode(value).buffer;
  }

  return null;
}

async function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: () => SQL_WASM_URL,
    });
  }

  return sqlJsPromise;
}

function querySqlJs(db: InstanceType<Awaited<ReturnType<typeof getSqlJs>>["Database"]>, sql: string) {
  const result = db.exec(sql);
  const first = result[0];
  if (!first) {
    return [];
  }

  return first.values.map((row) => {
    const mapped: Record<string, unknown> = {};
    first.columns.forEach((column, index) => {
      mapped[column] = row[index];
    });
    return mapped;
  });
}

async function importNodes(env: AppEnv["Bindings"], userId: string, rows: Array<Record<string, unknown>>) {
  const db = await getDb(env);
  const now = new Date().toISOString();

  // Validate and normalize all rows first (no DB calls)
  const validRows = rows
    .map((row) => {
      const type = typeof row.type === "string" ? row.type : null;
      const text = typeof row.text === "string" ? row.text.trim() : null;
      if (!type || !text) return null;
      return {
        id: typeof row.id === "string" ? row.id : createNodeId(),
        type,
        text,
        specificContext: typeof row.specific_context === "string" ? row.specific_context : null,
        filesTouched: typeof row.files_touched === "string" ? row.files_touched : null,
        confidence: typeof row.confidence === "number" ? row.confidence : 1,
        source: typeof row.source === "string" ? row.source : "migration",
        createdAt: typeof row.created_at === "string" ? row.created_at : now,
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : now,
        decayRate: typeof row.decay_rate === "number" ? row.decay_rate : 0.01,
        timesObserved: typeof row.times_observed === "number" ? row.times_observed : 1,
        embedding: normalizeImportedEmbedding(row.embedding),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (validRows.length === 0) return { created: 0, updated: 0 };

  // Use INSERT OR IGNORE to skip duplicates, batch all statements in one Turso call
  // This is a single HTTP subrequest regardless of how many statements
  const stmts = validRows.map((row) => ({
    sql: `INSERT INTO nodes (id, user_id, type, text, specific_context, files_touched, confidence, source, created_at, updated_at, decay_rate, times_observed, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            confidence = MAX(nodes.confidence, excluded.confidence),
            times_observed = nodes.times_observed + 1,
            updated_at = excluded.updated_at,
            embedding = COALESCE(excluded.embedding, nodes.embedding),
            specific_context = COALESCE(excluded.specific_context, nodes.specific_context),
            files_touched = COALESCE(excluded.files_touched, nodes.files_touched),
            source = COALESCE(excluded.source, nodes.source)`,
    args: [
      row.id,
      userId,
      row.type,
      row.text,
      row.specificContext,
      row.filesTouched,
      row.confidence,
      row.source,
      row.createdAt,
      row.updatedAt,
      row.decayRate,
      row.timesObserved,
      row.embedding,
    ],
  }));

  // Turso batch: all statements in ONE HTTP request (1 subrequest total)
  // Max ~500 statements per batch to stay safe
  const BATCH_LIMIT = 400;
  let created = 0;

  for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
    const batch = stmts.slice(i, i + BATCH_LIMIT);
    const results = await db.batch(batch as any, "write");
    for (const result of results) {
      created += result.rowsAffected ?? 0;
    }
  }

  return { created, updated: validRows.length - created };
}

async function importInsights(env: AppEnv["Bindings"], userId: string, rows: Array<Record<string, unknown>>) {
  const db = await getDb(env);
  const now = new Date().toISOString();

  const validRows = rows
    .map((row) => {
      const text = typeof row.text === "string" ? row.text.trim() : null;
      if (!text) return null;
      return {
        id: typeof row.id === "string" ? row.id : createInsightId(),
        text,
        supportingNodes: typeof row.supporting_nodes === "string" ? row.supporting_nodes : null,
        confidence: typeof row.confidence === "number" ? row.confidence : 0.4,
        discoveredAt: typeof row.discovered_at === "string" ? row.discovered_at : now,
        timesRediscovered: typeof row.times_rediscovered === "number" ? row.times_rediscovered : 0,
        timesUsed: typeof row.times_used === "number" ? row.times_used : 0,
        lastUsed: typeof row.last_used === "string" ? row.last_used : null,
        initiatedAt: typeof row.initiated_at === "string" ? row.initiated_at : null,
        embedding: normalizeImportedEmbedding(row.embedding),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (validRows.length === 0) return { created: 0, updated: 0 };

  const stmts = validRows.map((row) => ({
    sql: `INSERT INTO insights (id, user_id, text, supporting_nodes, confidence, discovered_at, times_rediscovered, times_used, last_used, initiated_at, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            confidence = MAX(insights.confidence, excluded.confidence),
            times_rediscovered = insights.times_rediscovered + 1,
            text = CASE WHEN LENGTH(excluded.text) > LENGTH(insights.text) THEN excluded.text ELSE insights.text END,
            embedding = COALESCE(excluded.embedding, insights.embedding)`,
    args: [
      row.id,
      userId,
      row.text,
      row.supportingNodes,
      row.confidence,
      row.discoveredAt,
      row.timesRediscovered,
      row.timesUsed,
      row.lastUsed,
      row.initiatedAt,
      row.embedding,
    ],
  }));

  const results = await db.batch(stmts as any, "write");
  let created = 0;
  for (const result of results) {
    created += result.rowsAffected ?? 0;
  }

  return { created, updated: validRows.length - created };
}

export const migrateRoutes = new Hono<AppEnv>();
migrateRoutes.use("*", authMiddleware, rateLimitMiddleware, requireUserAuth);

migrateRoutes.post("/upload", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let payload: ExportPayload | null = null;

  if (contentType.includes("application/json")) {
    payload = (await c.req.json().catch(() => null)) as ExportPayload | null;
  } else {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sqliteHeader = new TextDecoder().decode(bytes.slice(0, 15));

    if (sqliteHeader === "SQLite format 3") {
      const SQL = await getSqlJs();
      const sqliteDb = new SQL.Database(bytes);
      payload = {
        nodes: querySqlJs(sqliteDb, "SELECT id, type, text, specific_context, files_touched, confidence, source, created_at, updated_at, decay_rate, times_observed, embedding FROM nodes"),
        insights: querySqlJs(sqliteDb, "SELECT id, text, supporting_nodes, confidence, discovered_at, times_rediscovered, times_used, last_used, initiated_at, embedding FROM insights"),
      };
      sqliteDb.close();
    } else {
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes)) as ExportPayload;
      } catch {
        return c.json({ error: "unsupported_upload_format" }, 400);
      }
    }
  }

  const nodeImport = await importNodes(c.env, c.get("user").id, payload?.nodes ?? []);
  const insightImport = await importInsights(c.env, c.get("user").id, payload?.insights ?? []);

  return c.json({
    nodes_created: nodeImport.created,
    nodes_updated: nodeImport.updated,
    insights_created: insightImport.created,
    insights_updated: insightImport.updated,
  });
});

migrateRoutes.get("/export", async (c) => {
  const db = await getDb(c.env);
  const [nodes, insights] = await Promise.all([
    getUserNodes(db, c.get("user").id),
    getUserInsights(db, c.get("user").id),
  ]);

  return c.json({
    user_id: c.get("user").id,
    plan: c.get("user").plan,
    exported_at: new Date().toISOString(),
    nodes,
    insights,
  });
});

// Re-embed all nodes with current embedding model (fixes dimension mismatch)
migrateRoutes.post("/reembed", async (c) => {
  const user = c.get("user");
  const db = await getDb(c.env);
  const env = c.env;

  // Get all nodes for this user
  const result = await db.execute({
    sql: "SELECT id, text FROM nodes WHERE user_id = ? ORDER BY rowid LIMIT 20 OFFSET ?",
    args: [user.id, Number(c.req.query("offset") ?? "0")],
  });

  let updated = 0;
  const batchSize = 10;
  const rows = result.rows as unknown as Array<{ id: string; text: string }>;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const texts = batch.map((r) => r.text);

    const { generateEmbeddingBlobs } = await import("./embeddings");
    const blobs = await generateEmbeddingBlobs(env, texts);

    for (let j = 0; j < batch.length; j++) {
      await db.execute({
        sql: "UPDATE nodes SET embedding = ? WHERE id = ?",
        args: [blobs[j] as any, batch[j]!.id],
      });
      updated++;
    }
  }

  return c.json({ reembedded: updated, total: rows.length });
});
