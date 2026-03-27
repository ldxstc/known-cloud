import type { Client } from "@libsql/client/web";

import { createApiKeyId } from "./ids";
import { nowIso } from "./utils";

type Migration = {
  id: string;
  run: (db: Client) => Promise<void>;
};

async function hasColumn(db: Client, table: string, column: string) {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => String(row.name) === column);
}

async function addColumnIfMissing(db: Client, table: string, column: string, definition: string) {
  if (!(await hasColumn(db, table, column))) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function createMigrationTable(db: Client) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      executed_at TEXT NOT NULL
    )
  `);
}

const migrations: Migration[] = [
  {
    id: "001_week1_base",
    run: async (db) => {
      await db.executeMultiple(`
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
      `);
    },
  },
  {
    id: "002_auth_access_tables",
    run: async (db) => {
      await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          key_value TEXT UNIQUE NOT NULL,
          device_id TEXT UNIQUE,
          device_name TEXT,
          agent_platform TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          last_used_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS access_grants (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          developer_id TEXT NOT NULL,
          scopes TEXT NOT NULL,
          access_token TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          last_used_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS device_link_codes (
          code TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS request_rate_limits (
          subject_id TEXT NOT NULL,
          window_key TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (subject_id, window_key)
        );

        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_api_keys_key_value ON api_keys(key_value);
        CREATE INDEX IF NOT EXISTS idx_access_grants_user ON access_grants(user_id);
        CREATE INDEX IF NOT EXISTS idx_access_grants_token ON access_grants(access_token);
      `);

      const users = await db.execute("SELECT * FROM users");
      for (const row of users.rows) {
        const userId = String(row.id);
        const existing = await db.execute(
          "SELECT id FROM api_keys WHERE user_id = ? AND key_value = ? LIMIT 1",
          [userId, String(row.api_key)],
        );

        if (existing.rows.length > 0) {
          continue;
        }

        await db.execute(
          `INSERT INTO api_keys (
            id, user_id, key_value, device_id, device_name, agent_platform, created_at, revoked_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          [
            createApiKeyId(),
            userId,
            String(row.api_key),
            row.device_id === null ? null : String(row.device_id),
            row.device_name === null ? null : String(row.device_name),
            row.agent_platform === null ? null : String(row.agent_platform),
            String(row.created_at),
          ],
        );
      }
    },
  },
  {
    id: "003_billing_columns",
    run: async (db) => {
      await addColumnIfMissing(db, "users", "stripe_subscription_id", "stripe_subscription_id TEXT");
      await addColumnIfMissing(db, "users", "plan_period_end", "plan_period_end TEXT");
      await addColumnIfMissing(db, "users", "cancel_at_period_end", "cancel_at_period_end INTEGER DEFAULT 0");
    },
  },
  {
    id: "004_developers_table",
    run: async (db) => {
      await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS developers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          website TEXT NOT NULL,
          redirect_uri TEXT NOT NULL,
          client_id TEXT UNIQUE NOT NULL,
          client_secret TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_developers_client_id ON developers(client_id);
      `);
    },
  },
];

export async function runMigrations(db: Client) {
  await createMigrationTable(db);
  const applied = await db.execute("SELECT id FROM schema_migrations");
  const appliedIds = new Set(applied.rows.map((row) => String(row.id)));

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    await migration.run(db);
    await db.execute("INSERT INTO schema_migrations (id, executed_at) VALUES (?, ?)", [migration.id, nowIso()]);
  }
}
