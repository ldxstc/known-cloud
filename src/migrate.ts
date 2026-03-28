import { Hono } from "hono";
import initSqlJs from "sql.js";

import { getDb, getUserInsights, getUserNodes, insertInsight, insertNode, updateNodeObservation, upsertInsight, findUserNodeByTypeAndText } from "./db";
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
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const type = typeof row.type === "string" ? row.type : null;
    const text = typeof row.text === "string" ? row.text.trim() : null;
    if (!type || !text) {
      continue;
    }

    const existing = await findUserNodeByTypeAndText(db, userId, type, text);
    if (existing) {
      await updateNodeObservation(db, existing.id, {
        confidence: Math.max(existing.confidence, typeof row.confidence === "number" ? row.confidence : existing.confidence),
        embedding: normalizeImportedEmbedding(row.embedding) ?? existing.embedding,
        filesTouched: typeof row.files_touched === "string" ? row.files_touched : existing.files_touched,
        source: typeof row.source === "string" ? row.source : existing.source,
        specificContext: typeof row.specific_context === "string" ? row.specific_context : existing.specific_context,
        type,
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
      });
      updated += 1;
      continue;
    }

    await insertNode(db, {
      id: typeof row.id === "string" ? row.id : undefined,
      userId,
      type,
      text,
      specificContext: typeof row.specific_context === "string" ? row.specific_context : null,
      filesTouched: typeof row.files_touched === "string" ? row.files_touched : null,
      confidence: typeof row.confidence === "number" ? row.confidence : 1,
      source: typeof row.source === "string" ? row.source : "migration",
      createdAt: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
      decayRate: typeof row.decay_rate === "number" ? row.decay_rate : 0.01,
      timesObserved: typeof row.times_observed === "number" ? row.times_observed : 1,
      embedding: normalizeImportedEmbedding(row.embedding),
    });
    created += 1;
  }

  return { created, updated };
}

async function importInsights(env: AppEnv["Bindings"], userId: string, rows: Array<Record<string, unknown>>) {
  const db = await getDb(env);
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const text = typeof row.text === "string" ? row.text.trim() : null;
    if (!text) {
      continue;
    }

    const result = await upsertInsight(db, {
      userId,
      text,
      supportingNodes:
        typeof row.supporting_nodes === "string"
          ? (parseJsonArray(row.supporting_nodes) as string[])
          : undefined,
      confidence: typeof row.confidence === "number" ? row.confidence : 0.4,
      discoveredAt: typeof row.discovered_at === "string" ? row.discovered_at : new Date().toISOString(),
      embedding: normalizeImportedEmbedding(row.embedding),
    });

    if (result.created) {
      created += 1;
    } else {
      updated += 1;
    }
  }

  return { created, updated };
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
