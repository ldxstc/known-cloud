import { createClient, type Client, type Row } from "@libsql/client/web";

import { createInsightId, createNodeId, createUserId } from "./ids";

export interface EnvBindings {
  ENVIRONMENT?: string;
  OPENAI_API_KEY?: string;
  TURSO_AUTH_TOKEN?: string;
  TURSO_URL?: string;
}

export interface UserRow {
  id: string;
  device_id: string;
  api_key: string;
  agent_platform: string | null;
  device_name: string | null;
  plan: string;
  created_at: string;
  stripe_customer_id: string | null;
  usage_queries: number;
  usage_ingestions: number;
  usage_period: string | null;
}

export interface NodeRow {
  id: string;
  user_id: string;
  type: string;
  text: string;
  specific_context: string | null;
  files_touched: string | null;
  confidence: number;
  source: string | null;
  created_at: string;
  updated_at: string;
  decay_rate: number;
  times_observed: number;
  embedding: ArrayBuffer | null;
}

export interface InsightRow {
  id: string;
  user_id: string;
  text: string;
  supporting_nodes: string | null;
  confidence: number;
  discovered_at: string;
  times_rediscovered: number;
  times_used: number;
  last_used: string | null;
  initiated_at: string | null;
  embedding: ArrayBuffer | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  device_id TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  agent_platform TEXT,
  device_name TEXT,
  plan TEXT DEFAULT 'free',
  created_at TEXT NOT NULL,
  stripe_customer_id TEXT,
  usage_queries INTEGER DEFAULT 0,
  usage_ingestions INTEGER DEFAULT 0,
  usage_period TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  specific_context TEXT,
  files_touched TEXT,
  confidence REAL DEFAULT 1.0,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decay_rate REAL DEFAULT 0.01,
  times_observed INTEGER DEFAULT 1,
  embedding BLOB,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  supporting_nodes TEXT,
  confidence REAL DEFAULT 0.4,
  discovered_at TEXT NOT NULL,
  times_rediscovered INTEGER DEFAULT 0,
  times_used INTEGER DEFAULT 0,
  last_used TEXT,
  initiated_at TEXT,
  embedding BLOB,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);
CREATE INDEX IF NOT EXISTS idx_insights_user ON insights(user_id);
CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
`;

const schemaInit = new Map<string, Promise<void>>();

function requireEnv(name: keyof EnvBindings, value?: string) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function asString(value: Row[string] | undefined) {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}

function asRequiredString(value: Row[string] | undefined, field: string) {
  const stringValue = asString(value);
  if (stringValue === null) {
    throw new Error(`Missing required field "${field}" in database row.`);
  }

  return stringValue;
}

function asNumber(value: Row[string] | undefined) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.length > 0) {
    return Number(value);
  }

  return 0;
}

function asBlob(value: Row[string] | undefined) {
  return value instanceof ArrayBuffer ? value : null;
}

function mapUser(row: Row): UserRow {
  return {
    id: asRequiredString(row.id, "id"),
    device_id: asRequiredString(row.device_id, "device_id"),
    api_key: asRequiredString(row.api_key, "api_key"),
    agent_platform: asString(row.agent_platform),
    device_name: asString(row.device_name),
    plan: asRequiredString(row.plan, "plan"),
    created_at: asRequiredString(row.created_at, "created_at"),
    stripe_customer_id: asString(row.stripe_customer_id),
    usage_queries: asNumber(row.usage_queries),
    usage_ingestions: asNumber(row.usage_ingestions),
    usage_period: asString(row.usage_period),
  };
}

function mapNode(row: Row): NodeRow {
  return {
    id: asRequiredString(row.id, "id"),
    user_id: asRequiredString(row.user_id, "user_id"),
    type: asRequiredString(row.type, "type"),
    text: asRequiredString(row.text, "text"),
    specific_context: asString(row.specific_context),
    files_touched: asString(row.files_touched),
    confidence: asNumber(row.confidence),
    source: asString(row.source),
    created_at: asRequiredString(row.created_at, "created_at"),
    updated_at: asRequiredString(row.updated_at, "updated_at"),
    decay_rate: asNumber(row.decay_rate),
    times_observed: asNumber(row.times_observed),
    embedding: asBlob(row.embedding),
  };
}

function mapInsight(row: Row): InsightRow {
  return {
    id: asRequiredString(row.id, "id"),
    user_id: asRequiredString(row.user_id, "user_id"),
    text: asRequiredString(row.text, "text"),
    supporting_nodes: asString(row.supporting_nodes),
    confidence: asNumber(row.confidence),
    discovered_at: asRequiredString(row.discovered_at, "discovered_at"),
    times_rediscovered: asNumber(row.times_rediscovered),
    times_used: asNumber(row.times_used),
    last_used: asString(row.last_used),
    initiated_at: asString(row.initiated_at),
    embedding: asBlob(row.embedding),
  };
}

async function ensureUsageColumns(db: Client) {
  const result = await db.execute("PRAGMA table_info(users)");
  const columns = new Set(result.rows.map((row) => String(row.name)));

  if (!columns.has("usage_queries")) {
    await db.execute("ALTER TABLE users ADD COLUMN usage_queries INTEGER DEFAULT 0");
  }

  if (!columns.has("usage_ingestions")) {
    await db.execute("ALTER TABLE users ADD COLUMN usage_ingestions INTEGER DEFAULT 0");
  }

  if (!columns.has("usage_period")) {
    await db.execute("ALTER TABLE users ADD COLUMN usage_period TEXT");
  }
}

async function initializeSchema(db: Client, key: string) {
  let promise = schemaInit.get(key);

  if (!promise) {
    promise = (async () => {
      await db.executeMultiple(SCHEMA_SQL);
      await ensureUsageColumns(db);
    })().catch((error) => {
      schemaInit.delete(key);
      throw error;
    });

    schemaInit.set(key, promise);
  }

  await promise;
}

export async function getDb(env: EnvBindings) {
  const url = requireEnv("TURSO_URL", env.TURSO_URL);
  const db = createClient({
    url,
    authToken: env.TURSO_AUTH_TOKEN,
  });

  await initializeSchema(db, url);
  return db;
}

export async function getUserByDeviceId(db: Client, deviceId: string) {
  const result = await db.execute("SELECT * FROM users WHERE device_id = ? LIMIT 1", [deviceId]);
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function getUserByApiKey(db: Client, apiKey: string) {
  const result = await db.execute("SELECT * FROM users WHERE api_key = ? LIMIT 1", [apiKey]);
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function createUser(
  db: Client,
  input: {
    agentPlatform: string;
    apiKey: string;
    createdAt: string;
    deviceId: string;
    deviceName?: string | null;
    plan?: string;
    usagePeriod: string;
  },
) {
  const userId = createUserId();
  await db.execute(
    `INSERT INTO users (
      id,
      device_id,
      api_key,
      agent_platform,
      device_name,
      plan,
      created_at,
      usage_queries,
      usage_ingestions,
      usage_period
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    [
      userId,
      input.deviceId,
      input.apiKey,
      input.agentPlatform,
      input.deviceName ?? null,
      input.plan ?? "free",
      input.createdAt,
      input.usagePeriod,
    ],
  );

  const created = await getUserByDeviceId(db, input.deviceId);
  if (!created) {
    throw new Error("User creation failed.");
  }

  return created;
}

export async function updateUserUsagePeriod(db: Client, userId: string, usagePeriod: string) {
  await db.execute(
    "UPDATE users SET usage_queries = 0, usage_ingestions = 0, usage_period = ? WHERE id = ?",
    [usagePeriod, userId],
  );
}

export async function incrementUserUsage(db: Client, userId: string, field: "queries" | "ingestions") {
  const column = field === "queries" ? "usage_queries" : "usage_ingestions";
  await db.execute(`UPDATE users SET ${column} = ${column} + 1 WHERE id = ?`, [userId]);
}

export async function countUserNodes(db: Client, userId: string) {
  const result = await db.execute("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ?", [userId]);
  return asNumber(result.rows[0]?.count);
}

export async function countUserInsights(db: Client, userId: string) {
  const result = await db.execute("SELECT COUNT(*) AS count FROM insights WHERE user_id = ?", [userId]);
  return asNumber(result.rows[0]?.count);
}

export async function getUserNodes(db: Client, userId: string) {
  const result = await db.execute("SELECT * FROM nodes WHERE user_id = ? ORDER BY updated_at DESC", [userId]);
  return result.rows.map(mapNode);
}

export async function getUserInsights(db: Client, userId: string) {
  const result = await db.execute("SELECT * FROM insights WHERE user_id = ? ORDER BY confidence DESC, discovered_at DESC", [userId]);
  return result.rows.map(mapInsight);
}

export async function findUserNodeByTypeAndText(db: Client, userId: string, type: string, text: string) {
  const result = await db.execute(
    "SELECT * FROM nodes WHERE user_id = ? AND type = ? AND LOWER(text) = LOWER(?) LIMIT 1",
    [userId, type, text],
  );

  const row = result.rows[0];
  return row ? mapNode(row) : null;
}

export async function findInsightByText(db: Client, userId: string, text: string) {
  const result = await db.execute(
    "SELECT * FROM insights WHERE user_id = ? AND LOWER(text) = LOWER(?) LIMIT 1",
    [userId, text],
  );

  const row = result.rows[0];
  return row ? mapInsight(row) : null;
}

export async function insertNode(
  db: Client,
  input: {
    confidence: number;
    createdAt: string;
    decayRate?: number;
    embedding: ArrayBuffer | null;
    filesTouched?: string | null;
    source?: string | null;
    specificContext?: string | null;
    text: string;
    timesObserved?: number;
    type: string;
    updatedAt?: string;
    userId: string;
  },
) {
  const id = createNodeId();
  await db.execute(
    `INSERT INTO nodes (
      id,
      user_id,
      type,
      text,
      specific_context,
      files_touched,
      confidence,
      source,
      created_at,
      updated_at,
      decay_rate,
      times_observed,
      embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.type,
      input.text,
      input.specificContext ?? null,
      input.filesTouched ?? null,
      input.confidence,
      input.source ?? null,
      input.createdAt,
      input.updatedAt ?? input.createdAt,
      input.decayRate ?? 0.01,
      input.timesObserved ?? 1,
      input.embedding,
    ],
  );

  const inserted = await db.execute("SELECT * FROM nodes WHERE id = ? LIMIT 1", [id]);
  const row = inserted.rows[0];
  if (!row) {
    throw new Error("Node insertion failed.");
  }

  return mapNode(row);
}

export async function updateNodeObservation(
  db: Client,
  nodeId: string,
  updates: {
    confidence?: number;
    embedding?: ArrayBuffer | null;
    filesTouched?: string | null;
    source?: string | null;
    specificContext?: string | null;
    type?: string;
    updatedAt: string;
  },
) {
  await db.execute(
    `UPDATE nodes
     SET type = COALESCE(?, type),
         specific_context = COALESCE(?, specific_context),
         files_touched = COALESCE(?, files_touched),
         confidence = COALESCE(?, confidence),
         source = COALESCE(?, source),
         updated_at = ?,
         times_observed = times_observed + 1,
         embedding = COALESCE(?, embedding)
     WHERE id = ?`,
    [
      updates.type ?? null,
      updates.specificContext ?? null,
      updates.filesTouched ?? null,
      updates.confidence ?? null,
      updates.source ?? null,
      updates.updatedAt,
      updates.embedding ?? null,
      nodeId,
    ],
  );

  const result = await db.execute("SELECT * FROM nodes WHERE id = ? LIMIT 1", [nodeId]);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Node update failed.");
  }

  return mapNode(row);
}

export async function penalizeNodeConfidence(db: Client, nodeId: string, factor: number) {
  await db.execute("UPDATE nodes SET confidence = MAX(0.1, confidence * ?) WHERE id = ?", [factor, nodeId]);
}

export async function deleteNodesMatching(db: Client, userId: string, needle: string) {
  const likeNeedle = `%${needle.toLowerCase()}%`;
  const result = await db.execute(
    `DELETE FROM nodes
     WHERE user_id = ?
       AND (
         LOWER(text) LIKE ?
         OR LOWER(COALESCE(specific_context, '')) LIKE ?
       )`,
    [userId, likeNeedle, likeNeedle],
  );

  return typeof result.rowsAffected === "bigint" ? Number(result.rowsAffected) : (result.rowsAffected ?? 0);
}

export async function upsertInsight(
  db: Client,
  input: {
    confidence: number;
    discoveredAt: string;
    embedding: ArrayBuffer | null;
    initiatedAt?: string | null;
    supportingNodes?: string[] | null;
    text: string;
    userId: string;
  },
) {
  const existing = await findInsightByText(db, input.userId, input.text);
  if (existing) {
    await db.execute(
      `UPDATE insights
       SET confidence = MAX(confidence, ?),
           times_rediscovered = times_rediscovered + 1,
           supporting_nodes = COALESCE(?, supporting_nodes),
           embedding = COALESCE(?, embedding)
       WHERE id = ?`,
      [
        input.confidence,
        input.supportingNodes ? JSON.stringify(input.supportingNodes) : null,
        input.embedding,
        existing.id,
      ],
    );

    const refreshed = await db.execute("SELECT * FROM insights WHERE id = ? LIMIT 1", [existing.id]);
    const row = refreshed.rows[0];
    if (!row) {
      throw new Error("Insight refresh failed.");
    }

    return { created: false, row: mapInsight(row) };
  }

  const id = createInsightId();
  await db.execute(
    `INSERT INTO insights (
      id,
      user_id,
      text,
      supporting_nodes,
      confidence,
      discovered_at,
      times_rediscovered,
      times_used,
      last_used,
      initiated_at,
      embedding
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)`,
    [
      id,
      input.userId,
      input.text,
      input.supportingNodes ? JSON.stringify(input.supportingNodes) : null,
      input.confidence,
      input.discoveredAt,
      input.initiatedAt ?? null,
      input.embedding,
    ],
  );

  const inserted = await db.execute("SELECT * FROM insights WHERE id = ? LIMIT 1", [id]);
  const row = inserted.rows[0];
  if (!row) {
    throw new Error("Insight insertion failed.");
  }

  return { created: true, row: mapInsight(row) };
}

export async function markInsightsUsed(db: Client, insightIds: string[], timestamp: string) {
  for (const insightId of insightIds) {
    await db.execute(
      "UPDATE insights SET times_used = times_used + 1, last_used = ? WHERE id = ?",
      [timestamp, insightId],
    );
  }
}
