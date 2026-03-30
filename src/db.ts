import { createClient, type Client, type Row } from "@libsql/client/web";

import {
  createAccessGrantId,
  createAccessToken,
  createApiKeyId,
  createDeveloperClientId,
  createDeveloperClientSecret,
  createDeveloperId,
  createInsightId,
  createMessageId,
  createNodeId,
  createUserId,
} from "./ids";
import { runMigrations } from "./migrations";
import { nowIso, parseJsonArray, sanitizeNullableString, stringifyJsonArray } from "./utils";

export interface EnvBindings {
  APP_BASE_URL?: string;
  ENVIRONMENT?: string;
  OPENAI_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  TURSO_AUTH_TOKEN?: string;
  TURSO_URL?: string;
  AI?: any; // Cloudflare Workers AI binding (free embeddings)
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
  stripe_subscription_id: string | null;
  plan_period_end: string | null;
  cancel_at_period_end: boolean;
  usage_queries: number;
  usage_ingestions: number;
  usage_period: string | null;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  key_value: string;
  device_id: string | null;
  device_name: string | null;
  agent_platform: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface AccessGrantRow {
  id: string;
  user_id: string;
  developer_id: string;
  scopes: string;
  access_token: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface DeveloperRow {
  id: string;
  name: string;
  website: string;
  redirect_uri: string;
  client_id: string;
  client_secret: string;
  created_at: string;
}

export interface DeviceLinkCodeRow {
  code: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
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

export interface MessageRow {
  id: string;
  user_id: string;
  session_id: string | null;
  source: string | null;
  text: string;
  created_at: string;
}

const initialized = new Map<string, Promise<void>>();

function requireEnv(name: keyof EnvBindings, value?: string) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function asString(value: Row[string] | undefined) {
  if (value === undefined || value === null) {
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

function asBoolean(value: Row[string] | undefined) {
  return asNumber(value) !== 0;
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
    stripe_subscription_id: asString(row.stripe_subscription_id),
    plan_period_end: asString(row.plan_period_end),
    cancel_at_period_end: asBoolean(row.cancel_at_period_end),
    usage_queries: asNumber(row.usage_queries),
    usage_ingestions: asNumber(row.usage_ingestions),
    usage_period: asString(row.usage_period),
  };
}

function mapApiKey(row: Row): ApiKeyRow {
  return {
    id: asRequiredString(row.id, "id"),
    user_id: asRequiredString(row.user_id, "user_id"),
    key_value: asRequiredString(row.key_value, "key_value"),
    device_id: asString(row.device_id),
    device_name: asString(row.device_name),
    agent_platform: asString(row.agent_platform),
    created_at: asRequiredString(row.created_at, "created_at"),
    revoked_at: asString(row.revoked_at),
    last_used_at: asString(row.last_used_at),
  };
}

function mapAccessGrant(row: Row): AccessGrantRow {
  return {
    id: asRequiredString(row.id, "id"),
    user_id: asRequiredString(row.user_id, "user_id"),
    developer_id: asRequiredString(row.developer_id, "developer_id"),
    scopes: asRequiredString(row.scopes, "scopes"),
    access_token: asRequiredString(row.access_token, "access_token"),
    created_at: asRequiredString(row.created_at, "created_at"),
    revoked_at: asString(row.revoked_at),
    last_used_at: asString(row.last_used_at),
  };
}

function mapDeveloper(row: Row): DeveloperRow {
  return {
    id: asRequiredString(row.id, "id"),
    name: asRequiredString(row.name, "name"),
    website: asRequiredString(row.website, "website"),
    redirect_uri: asRequiredString(row.redirect_uri, "redirect_uri"),
    client_id: asRequiredString(row.client_id, "client_id"),
    client_secret: asRequiredString(row.client_secret, "client_secret"),
    created_at: asRequiredString(row.created_at, "created_at"),
  };
}

function mapDeviceLinkCode(row: Row): DeviceLinkCodeRow {
  return {
    code: asRequiredString(row.code, "code"),
    user_id: asRequiredString(row.user_id, "user_id"),
    created_at: asRequiredString(row.created_at, "created_at"),
    expires_at: asRequiredString(row.expires_at, "expires_at"),
    consumed_at: asString(row.consumed_at),
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

function mapMessage(row: Row): MessageRow {
  return {
    id: asRequiredString(row.id, "id"),
    user_id: asRequiredString(row.user_id, "user_id"),
    session_id: asString(row.session_id),
    source: asString(row.source),
    text: asRequiredString(row.text, "text"),
    created_at: asRequiredString(row.created_at, "created_at"),
  };
}

async function initializeDb(db: Client, key: string) {
  let promise = initialized.get(key);

  if (!promise) {
    promise = (async () => {
      await runMigrations(db);
    })().catch((error) => {
      initialized.delete(key);
      throw error;
    });

    initialized.set(key, promise);
  }

  await promise;
}

export async function getDb(env: EnvBindings) {
  const url = requireEnv("TURSO_URL", env.TURSO_URL);
  const db = createClient({
    url,
    authToken: env.TURSO_AUTH_TOKEN,
  });

  await initializeDb(db, url);
  return db;
}

export async function getUserById(db: Client, userId: string) {
  const result = await db.execute("SELECT * FROM users WHERE id = ? LIMIT 1", [userId]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function getUserByStripeCustomerId(db: Client, customerId: string) {
  const result = await db.execute("SELECT * FROM users WHERE stripe_customer_id = ? LIMIT 1", [customerId]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function getUserByStripeSubscriptionId(db: Client, subscriptionId: string) {
  const result = await db.execute("SELECT * FROM users WHERE stripe_subscription_id = ? LIMIT 1", [subscriptionId]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function getActiveApiKeyByValue(db: Client, keyValue: string) {
  const result = await db.execute(
    "SELECT * FROM api_keys WHERE key_value = ? LIMIT 1",
    [keyValue],
  );

  return result.rows[0] ? mapApiKey(result.rows[0]) : null;
}

export async function getActiveApiKeyById(db: Client, keyId: string) {
  const result = await db.execute("SELECT * FROM api_keys WHERE id = ? LIMIT 1", [keyId]);
  return result.rows[0] ? mapApiKey(result.rows[0]) : null;
}

export async function getActiveApiKeyByDeviceId(db: Client, deviceId: string) {
  const result = await db.execute(
    "SELECT * FROM api_keys WHERE device_id = ? LIMIT 1",
    [deviceId],
  );

  return result.rows[0] ? mapApiKey(result.rows[0]) : null;
}

export async function listActiveApiKeys(db: Client, userId: string) {
  const result = await db.execute(
    "SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
    [userId],
  );

  return result.rows.map(mapApiKey);
}

export async function countActiveApiKeys(db: Client, userId: string) {
  const result = await db.execute(
    "SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ?",
    [userId],
  );

  return asNumber(result.rows[0]?.count);
}

export async function createApiKeyRecord(
  db: Client,
  input: {
    userId: string;
    keyValue: string;
    deviceId?: string | null;
    deviceName?: string | null;
    agentPlatform?: string | null;
    createdAt?: string;
  },
) {
  const createdAt = input.createdAt ?? nowIso();
  const id = createApiKeyId();
  await db.execute(
    `INSERT INTO api_keys (
      id, user_id, key_value, device_id, device_name, agent_platform, created_at, revoked_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [
      id,
      input.userId,
      input.keyValue,
      sanitizeNullableString(input.deviceId),
      sanitizeNullableString(input.deviceName),
      sanitizeNullableString(input.agentPlatform),
      createdAt,
    ],
  );

  const created = await getActiveApiKeyById(db, id);
  if (!created) {
    throw new Error("API key creation failed.");
  }

  return created;
}

export async function revokeApiKey(db: Client, userId: string, keyId: string) {
  await db.execute(
    "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ?",
    [nowIso(), keyId, userId],
  );

  return asNumber((await db.execute("SELECT changes() AS count")).rows[0]?.count);
}

export async function touchApiKey(db: Client, keyId: string) {
  await db.execute("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [nowIso(), keyId]);
}

export async function getUserByDeviceId(db: Client, deviceId: string) {
  const apiKey = await getActiveApiKeyByDeviceId(db, deviceId);
  if (!apiKey) {
    return null;
  }

  return getUserById(db, apiKey.user_id);
}

export async function getActiveAccessGrantByToken(db: Client, token: string) {
  const result = await db.execute(
    "SELECT * FROM access_grants WHERE access_token = ? LIMIT 1",
    [token],
  );

  return result.rows[0] ? mapAccessGrant(result.rows[0]) : null;
}

export async function getActiveAccessGrantByUserAndDeveloper(db: Client, userId: string, developerId: string) {
  const result = await db.execute(
    `SELECT * FROM access_grants
     WHERE user_id = ? AND developer_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [userId, developerId],
  );

  return result.rows[0] ? mapAccessGrant(result.rows[0]) : null;
}

export async function createOrUpdateAccessGrant(
  db: Client,
  input: {
    userId: string;
    developerId: string;
    scopes: string[];
  },
) {
  const existing = await getActiveAccessGrantByUserAndDeveloper(db, input.userId, input.developerId);
  const scopes = stringifyJsonArray(input.scopes);

  if (existing) {
    await db.execute(
      "UPDATE access_grants SET scopes = ?, last_used_at = NULL WHERE id = ?",
      [scopes, existing.id],
    );

    const refreshed = await getActiveAccessGrantByUserAndDeveloper(db, input.userId, input.developerId);
    if (!refreshed) {
      throw new Error("Access grant refresh failed.");
    }

    return refreshed;
  }

  const id = createAccessGrantId();
  const createdAt = nowIso();
  await db.execute(
    `INSERT INTO access_grants (
      id, user_id, developer_id, scopes, access_token, created_at, revoked_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [
      id,
      input.userId,
      input.developerId,
      scopes,
      createAccessToken(),
      createdAt,
    ],
  );

  const created = await db.execute("SELECT * FROM access_grants WHERE id = ? LIMIT 1", [id]);
  if (!created.rows[0]) {
    throw new Error("Access grant creation failed.");
  }

  return mapAccessGrant(created.rows[0]);
}

export async function listActiveAccessGrants(db: Client, userId: string) {
  const result = await db.execute(
    "SELECT * FROM access_grants WHERE user_id = ? ORDER BY created_at DESC",
    [userId],
  );

  return result.rows.map(mapAccessGrant);
}

export async function revokeAccessGrant(db: Client, userId: string, developerId: string) {
  await db.execute(
    `UPDATE access_grants
     SET revoked_at = ?
     WHERE user_id = ? AND developer_id = ?`,
    [nowIso(), userId, developerId],
  );

  return asNumber((await db.execute("SELECT changes() AS count")).rows[0]?.count);
}

export async function touchAccessGrant(db: Client, grantId: string) {
  await db.execute("UPDATE access_grants SET last_used_at = ? WHERE id = ?", [nowIso(), grantId]);
}

export async function createDeviceLinkCode(
  db: Client,
  input: {
    code: string;
    userId: string;
    createdAt?: string;
    expiresAt: string;
  },
) {
  const createdAt = input.createdAt ?? nowIso();
  await db.execute("DELETE FROM device_link_codes WHERE user_id = ? AND consumed_at IS NULL", [input.userId]);
  await db.execute(
    `INSERT INTO device_link_codes (code, user_id, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, NULL)`,
    [input.code, input.userId, createdAt, input.expiresAt],
  );

  const result = await db.execute("SELECT * FROM device_link_codes WHERE code = ? LIMIT 1", [input.code]);
  if (!result.rows[0]) {
    throw new Error("Device link code creation failed.");
  }

  return mapDeviceLinkCode(result.rows[0]);
}

export async function getActiveDeviceLinkCode(db: Client, code: string) {
  const result = await db.execute(
    `SELECT * FROM device_link_codes
     WHERE code = ? AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [code],
  );

  return result.rows[0] ? mapDeviceLinkCode(result.rows[0]) : null;
}

export async function consumeDeviceLinkCode(db: Client, code: string) {
  await db.execute("UPDATE device_link_codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL", [nowIso(), code]);
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
      stripe_customer_id,
      stripe_subscription_id,
      plan_period_end,
      cancel_at_period_end,
      usage_queries,
      usage_ingestions,
      usage_period
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 0, ?)`,
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

  await createApiKeyRecord(db, {
    userId,
    keyValue: input.apiKey,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    agentPlatform: input.agentPlatform,
    createdAt: input.createdAt,
  });

  const created = await getUserById(db, userId);
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

export async function updateUserPlan(
  db: Client,
  input: {
    userId: string;
    plan: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    planPeriodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
  },
) {
  const existing = await getUserById(db, input.userId);
  if (!existing) {
    throw new Error("User not found.");
  }

  await db.execute(
    `UPDATE users
     SET plan = ?,
         stripe_customer_id = ?,
         stripe_subscription_id = ?,
         plan_period_end = ?,
         cancel_at_period_end = ?
     WHERE id = ?`,
    [
      input.plan,
      input.stripeCustomerId === undefined ? existing.stripe_customer_id : (input.stripeCustomerId ?? null),
      input.stripeSubscriptionId === undefined ? existing.stripe_subscription_id : (input.stripeSubscriptionId ?? null),
      input.planPeriodEnd === undefined ? existing.plan_period_end : (input.planPeriodEnd ?? null),
      input.cancelAtPeriodEnd === undefined ? (existing.cancel_at_period_end ? 1 : 0) : (input.cancelAtPeriodEnd ? 1 : 0),
      input.userId,
    ],
  );
}

export async function countUserNodes(db: Client, userId: string) {
  const result = await db.execute("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ?", [userId]);
  return asNumber(result.rows[0]?.count);
}

export async function countUserInsights(db: Client, userId: string) {
  const result = await db.execute("SELECT COUNT(*) AS count FROM insights WHERE user_id = ?", [userId]);
  return asNumber(result.rows[0]?.count);
}

export async function insertMessage(
  db: Client,
  input: {
    userId: string;
    sessionId?: string | null;
    source?: string | null;
    text: string;
    createdAt?: string;
    id?: string;
  },
) {
  const id = input.id ?? createMessageId();
  const createdAt = input.createdAt ?? nowIso();
  await db.execute(
    `INSERT INTO messages (id, user_id, session_id, source, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      sanitizeNullableString(input.sessionId),
      sanitizeNullableString(input.source),
      input.text,
      createdAt,
    ],
  );

  const result = await db.execute("SELECT * FROM messages WHERE id = ? LIMIT 1", [id]);
  if (!result.rows[0]) {
    throw new Error("Message insertion failed.");
  }

  return mapMessage(result.rows[0]);
}

export async function grepUserMessages(db: Client, userId: string, query: string, limit: number = 10) {
  const result = await db.execute(
    `SELECT * FROM messages
     WHERE user_id = ? AND text LIKE ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, `%${query}%`, limit],
  );

  return result.rows.map(mapMessage);
}

export async function findUserNodeById(db: Client, userId: string, nodeId: string) {
  const result = await db.execute("SELECT * FROM nodes WHERE user_id = ? AND id = ? LIMIT 1", [userId, nodeId]);
  return result.rows[0] ? mapNode(result.rows[0]) : null;
}

export async function findMessagesBySessionOrSource(db: Client, userId: string, value: string, limit: number = 5) {
  const result = await db.execute(
    `SELECT * FROM messages
     WHERE user_id = ? AND (session_id = ? OR source = ?)
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, value, value, limit],
  );

  return result.rows.map(mapMessage);
}

export async function getUserNodes(db: Client, userId: string) {
  const result = await db.execute(
    "SELECT * FROM nodes WHERE user_id = ? ORDER BY confidence DESC, updated_at DESC",
    [userId],
  );

  return result.rows.map(mapNode);
}

export async function getUserInsights(db: Client, userId: string) {
  const result = await db.execute(
    "SELECT * FROM insights WHERE user_id = ? ORDER BY confidence DESC, times_rediscovered DESC, discovered_at DESC",
    [userId],
  );

  return result.rows.map(mapInsight);
}

export async function getDistinctUserNodeTypes(db: Client, userId: string) {
  const result = await db.execute("SELECT DISTINCT type FROM nodes WHERE user_id = ? ORDER BY type ASC", [userId]);
  return result.rows.map((row) => asRequiredString(row.type, "type"));
}

export async function getUserNodesByType(db: Client, userId: string, type: string, limit: number = 5) {
  const result = await db.execute(
    `SELECT * FROM nodes
     WHERE user_id = ? AND type = ?
     ORDER BY confidence DESC, times_observed DESC, updated_at DESC
     LIMIT ?`,
    [userId, type, limit],
  );

  return result.rows.map(mapNode);
}

export async function findUserNodeByTypeAndText(db: Client, userId: string, type: string, text: string) {
  const result = await db.execute(
    "SELECT * FROM nodes WHERE user_id = ? AND type = ? AND LOWER(text) = LOWER(?) LIMIT 1",
    [userId, type, text],
  );

  return result.rows[0] ? mapNode(result.rows[0]) : null;
}

export async function insertNode(
  db: Client,
  input: {
    confidence: number;
    createdAt: string;
    decayRate?: number;
    embedding: ArrayBuffer | null;
    filesTouched?: string | null;
    id?: string;
    source?: string | null;
    specificContext?: string | null;
    text: string;
    timesObserved?: number;
    type: string;
    updatedAt?: string;
    userId: string;
  },
) {
  const id = input.id ?? createNodeId();
  await db.execute(
    `INSERT INTO nodes (
      id, user_id, type, text, specific_context, files_touched, confidence, source,
      created_at, updated_at, decay_rate, times_observed, embedding
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

  const result = await db.execute("SELECT * FROM nodes WHERE id = ? LIMIT 1", [id]);
  if (!result.rows[0]) {
    throw new Error("Node insertion failed.");
  }

  return mapNode(result.rows[0]);
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
  if (!result.rows[0]) {
    throw new Error("Node update failed.");
  }

  return mapNode(result.rows[0]);
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

export async function findInsightByText(db: Client, userId: string, text: string) {
  const result = await db.execute(
    "SELECT * FROM insights WHERE user_id = ? AND LOWER(text) = LOWER(?) LIMIT 1",
    [userId, text],
  );

  return result.rows[0] ? mapInsight(result.rows[0]) : null;
}

export async function insertInsight(
  db: Client,
  input: {
    id?: string;
    userId: string;
    text: string;
    supportingNodes?: string[] | null;
    confidence?: number;
    discoveredAt?: string;
    embedding?: ArrayBuffer | null;
    initiatedAt?: string | null;
  },
) {
  const id = input.id ?? createInsightId();
  const discoveredAt = input.discoveredAt ?? nowIso();
  await db.execute(
    `INSERT INTO insights (
      id, user_id, text, supporting_nodes, confidence, discovered_at,
      times_rediscovered, times_used, last_used, initiated_at, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)`,
    [
      id,
      input.userId,
      input.text,
      input.supportingNodes ? stringifyJsonArray(input.supportingNodes) : null,
      input.confidence ?? 0.4,
      discoveredAt,
      input.initiatedAt ?? null,
      input.embedding ?? null,
    ],
  );

  const result = await db.execute("SELECT * FROM insights WHERE id = ? LIMIT 1", [id]);
  if (!result.rows[0]) {
    throw new Error("Insight insertion failed.");
  }

  return mapInsight(result.rows[0]);
}

export async function strengthenInsight(
  db: Client,
  insightId: string,
  updates?: {
    text?: string;
    embedding?: ArrayBuffer | null;
  },
) {
  await db.execute(
    `UPDATE insights
     SET times_rediscovered = times_rediscovered + 1,
         confidence = MIN(1.0, confidence + 0.1),
         text = COALESCE(?, text),
         embedding = COALESCE(?, embedding)
     WHERE id = ?`,
    [
      updates?.text ?? null,
      updates?.embedding ?? null,
      insightId,
    ],
  );

  const result = await db.execute("SELECT * FROM insights WHERE id = ? LIMIT 1", [insightId]);
  if (!result.rows[0]) {
    throw new Error("Insight strengthen failed.");
  }

  return mapInsight(result.rows[0]);
}

export async function updateInsightSupportingNodes(db: Client, insightId: string, nodeIds: string[]) {
  const unique = [...new Set(nodeIds)];
  await db.execute("UPDATE insights SET supporting_nodes = ? WHERE id = ?", [stringifyJsonArray(unique), insightId]);
}

export async function addInsightSupport(db: Client, insightId: string, nodeIds: string[]) {
  const result = await db.execute("SELECT * FROM insights WHERE id = ? LIMIT 1", [insightId]);
  if (!result.rows[0]) {
    return;
  }

  const current = mapInsight(result.rows[0]);
  const merged = [...new Set([...parseJsonArray(current.supporting_nodes), ...nodeIds])];
  await updateInsightSupportingNodes(db, insightId, merged);
}

export async function upsertInsight(
  db: Client,
  input: {
    userId: string;
    text: string;
    supportingNodes?: string[] | null;
    confidence: number;
    discoveredAt: string;
    embedding: ArrayBuffer | null;
  },
) {
  const existing = await findInsightByText(db, input.userId, input.text);
  if (existing) {
    const row = await strengthenInsight(db, existing.id, {
      text: input.text.length > existing.text.length ? input.text : undefined,
      embedding: input.embedding ?? undefined,
    });
    await addInsightSupport(db, row.id, input.supportingNodes ?? []);
    return { created: false, row };
  }

  const row = await insertInsight(db, {
    userId: input.userId,
    text: input.text,
    supportingNodes: input.supportingNodes ?? undefined,
    confidence: input.confidence,
    discoveredAt: input.discoveredAt,
    embedding: input.embedding,
  });

  return { created: true, row };
}

export async function markInsightsUsed(db: Client, insightIds: string[], timestamp: string) {
  for (const insightId of insightIds) {
    await db.execute(
      `UPDATE insights
       SET times_used = times_used + 1,
           last_used = ?,
           confidence = MIN(1.0, confidence + 0.05)
       WHERE id = ?`,
      [timestamp, insightId],
    );
  }
}

export async function markInsightInitiated(db: Client, insightId: string, timestamp: string = nowIso()) {
  await db.execute("UPDATE insights SET initiated_at = COALESCE(initiated_at, ?) WHERE id = ?", [timestamp, insightId]);
}

export async function createDeveloper(
  db: Client,
  input: {
    name: string;
    website: string;
    redirectUri: string;
  },
) {
  const id = createDeveloperId();
  await db.execute(
    `INSERT INTO developers (id, name, website, redirect_uri, client_id, client_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.website,
      input.redirectUri,
      createDeveloperClientId(),
      createDeveloperClientSecret(),
      nowIso(),
    ],
  );

  const result = await db.execute("SELECT * FROM developers WHERE id = ? LIMIT 1", [id]);
  if (!result.rows[0]) {
    throw new Error("Developer creation failed.");
  }

  return mapDeveloper(result.rows[0]);
}

export async function getDeveloperById(db: Client, developerId: string) {
  const result = await db.execute("SELECT * FROM developers WHERE id = ? LIMIT 1", [developerId]);
  return result.rows[0] ? mapDeveloper(result.rows[0]) : null;
}

export async function listDevelopers(db: Client) {
  const result = await db.execute("SELECT * FROM developers ORDER BY created_at DESC");
  return result.rows.map(mapDeveloper);
}

export async function incrementRateLimitWindow(db: Client, subjectId: string, windowKey: string) {
  await db.execute(
    `INSERT INTO request_rate_limits (subject_id, window_key, count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(subject_id, window_key)
     DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
    [subjectId, windowKey, nowIso()],
  );

  const result = await db.execute(
    "SELECT count FROM request_rate_limits WHERE subject_id = ? AND window_key = ? LIMIT 1",
    [subjectId, windowKey],
  );

  return asNumber(result.rows[0]?.count);
}

export async function cleanupOldRateLimitWindows(db: Client, cutoffIso: string) {
  await db.execute("DELETE FROM request_rate_limits WHERE updated_at < ?", [cutoffIso]);
}


export async function findUserNodeByTextPrefix(db: Client, userId: string, textPrefix: string) {
  const result = await db.execute({
    sql: "SELECT id FROM nodes WHERE user_id = ? AND text LIKE ? LIMIT 1",
    args: [userId, textPrefix + "%"],
  });
  return result.rows.length > 0 ? result.rows[0] : null;
}
