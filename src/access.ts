import { Hono } from "hono";

import {
  createOrUpdateAccessGrant,
  getDb,
  getDeveloperById,
  listActiveAccessGrants,
  revokeAccessGrant,
} from "./db";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import type { AppEnv } from "./types";

type AccessGrantBody = {
  developer_id?: string;
  scopes?: string[];
};

const ALLOWED_SCOPES = new Set(["understand", "search", "ingest"]);

export const accessRoutes = new Hono<AppEnv>();
accessRoutes.use("*", authMiddleware, rateLimitMiddleware, requireUserAuth);

accessRoutes.post("/grant", async (c) => {
  const body = (await c.req.json().catch(() => null)) as AccessGrantBody | null;
  const developerId = body?.developer_id?.trim();
  const scopes = (body?.scopes ?? []).filter((scope): scope is string => typeof scope === "string");

  if (!developerId || scopes.length === 0) {
    return c.json({ error: "developer_id and scopes are required" }, 400);
  }

  const invalid = scopes.filter((scope) => !ALLOWED_SCOPES.has(scope));
  if (invalid.length > 0) {
    return c.json({ error: "invalid_scopes", scopes: invalid }, 400);
  }

  const db = await getDb(c.env);
  const developer = await getDeveloperById(db, developerId);
  if (!developer) {
    return c.json({ error: "developer_not_found" }, 404);
  }

  const grant = await createOrUpdateAccessGrant(db, {
    userId: c.get("user").id,
    developerId,
    scopes,
  });

  return c.json({
    access_token: grant.access_token,
    scopes: JSON.parse(grant.scopes) as string[],
    expires_in: null,
  });
});

accessRoutes.delete("/revoke/:developerId", async (c) => {
  const developerId = c.req.param("developerId");
  const db = await getDb(c.env);
  const revoked = await revokeAccessGrant(db, c.get("user").id, developerId);

  if (revoked === 0) {
    return c.json({ error: "grant_not_found" }, 404);
  }

  return c.json({ revoked: true, developer_id: developerId });
});

accessRoutes.get("/list", async (c) => {
  const db = await getDb(c.env);
  const grants = await listActiveAccessGrants(db, c.get("user").id);
  const items = await Promise.all(
    grants.map(async (grant) => {
      const developer = await getDeveloperById(db, grant.developer_id);
      return {
        developer_id: grant.developer_id,
        name: developer?.name ?? null,
        website: developer?.website ?? null,
        redirect_uri: developer?.redirect_uri ?? null,
        scopes: JSON.parse(grant.scopes) as string[],
        created_at: grant.created_at,
      };
    }),
  );

  return c.json({ access: items });
});
