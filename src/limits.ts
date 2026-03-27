import type { Client } from "@libsql/client/web";
import type { Context } from "hono";

import type { AppEnv } from "./middleware";
import type { UserRow } from "./db";
import { incrementUserUsage, updateUserUsagePeriod } from "./db";

export type UsageKind = "queries" | "ingestions";

export type PlanLimits = {
  queries: number;
  ingestions: number;
};

const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { queries: 1000, ingestions: 100 },
  starter: { queries: 10000, ingestions: 1000 },
  pro: { queries: 100000, ingestions: 10000 },
};

export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

export function getUsagePeriod(date: Date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function getUsageValue(user: UserRow, kind: UsageKind) {
  return kind === "queries" ? user.usage_queries : user.usage_ingestions;
}

function setUsageValue(user: UserRow, kind: UsageKind, value: number): UserRow {
  return kind === "queries"
    ? { ...user, usage_queries: value }
    : { ...user, usage_ingestions: value };
}

export async function syncUsagePeriod(c: Context<AppEnv>, db: Client) {
  const user = c.get("user");
  const usagePeriod = getUsagePeriod();

  if (user.usage_period === usagePeriod) {
    return user;
  }

  await updateUserUsagePeriod(db, user.id, usagePeriod);
  const refreshed = {
    ...user,
    usage_period: usagePeriod,
    usage_queries: 0,
    usage_ingestions: 0,
  };

  c.set("user", refreshed);
  return refreshed;
}

export async function ensureWithinLimit(c: Context<AppEnv>, db: Client, kind: UsageKind) {
  const user = await syncUsagePeriod(c, db);
  const limits = getPlanLimits(user.plan);
  const current = getUsageValue(user, kind);
  const ceiling = limits[kind];

  if (current < ceiling) {
    return null;
  }

  return c.json(
    {
      error: "limit_exceeded",
      plan: user.plan,
      usage: {
        queries: user.usage_queries,
        ingestions: user.usage_ingestions,
        period: user.usage_period,
      },
      limits,
      upgrade_prompt:
        kind === "queries"
          ? "Monthly query limit reached. Upgrade your Known Cloud plan to continue using understand and search."
          : "Monthly ingestion limit reached. Upgrade your Known Cloud plan to continue storing new memory.",
    },
    402,
  );
}

export async function recordUsage(c: Context<AppEnv>, db: Client, kind: UsageKind) {
  const user = await syncUsagePeriod(c, db);
  await incrementUserUsage(db, user.id, kind);
  c.set("user", setUsageValue(user, kind, getUsageValue(user, kind) + 1));
}
