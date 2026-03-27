import { Hono } from "hono";

import { countUserInsights, countUserNodes, getDb } from "./db";
import { getPlanLimits, syncUsagePeriod } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import type { AppEnv } from "./types";

export const statsRoutes = new Hono<AppEnv>();
statsRoutes.use("*", authMiddleware, rateLimitMiddleware, requireUserAuth);

statsRoutes.get("/", async (c) => {
  const db = await getDb(c.env);
  const user = await syncUsagePeriod(c, db);
  const [nodes, insights] = await Promise.all([
    countUserNodes(db, user.id),
    countUserInsights(db, user.id),
  ]);

  return c.json({
    nodes,
    edges: 0,
    insights,
    plan: user.plan,
    usage: {
      queries: user.usage_queries,
      ingestions: user.usage_ingestions,
      period: user.usage_period,
    },
    limits: getPlanLimits(user.plan),
  });
});
