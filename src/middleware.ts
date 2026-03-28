import { createMiddleware } from "hono/factory";

import {
  cleanupOldRateLimitWindows,
  getActiveAccessGrantByToken,
  getActiveApiKeyByValue,
  getDb,
  getUserById,
  incrementRateLimitWindow,
  touchAccessGrant,
  touchApiKey,
} from "./db";
import type { AppEnv } from "./types";
import { getRequestsPerMinuteLimit } from "./limits";

function parseBearerToken(header: string | undefined) {
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function currentRateWindowKey(date: Date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token = parseBearerToken(c.req.header("Authorization"));

  if (!token) {
    return c.json({ error: "missing_authorization" }, 401);
  }

  let db;
  try {
    db = await getDb(c.env);
  } catch {
    return c.json({ error: "internal_error", message: "Database unavailable" }, 500);
  }

  let apiKey;
  try {
    apiKey = await getActiveApiKeyByValue(db, token);
  } catch (err) {
    // DB error or key format error — treat as invalid
    console.error("API key lookup error:", err);
    return c.json({ error: "invalid_api_key", message: "Invalid API key" }, 401);
  }
  if (apiKey) {
    const user = await getUserById(db, apiKey.user_id);
    if (!user) {
      return c.json({ error: "invalid_api_key" }, 401);
    }

    await touchApiKey(db, apiKey.id);
    c.set("user", user);
    c.set("auth", {
      type: "user",
      apiKey,
      scopes: ["*"],
    });
    await next();
    return;
  }

  const accessGrant = await getActiveAccessGrantByToken(db, token);
  if (accessGrant) {
    const user = await getUserById(db, accessGrant.user_id);
    if (!user) {
      return c.json({ error: "invalid_access_token" }, 401);
    }

    await touchAccessGrant(db, accessGrant.id);
    c.set("user", user);
    c.set("auth", {
      type: "developer",
      accessGrant,
      scopes: JSON.parse(accessGrant.scopes) as string[],
    });
    await next();
    return;
  }

  return c.json({ error: "invalid_authorization" }, 401);
});

export const rateLimitMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const db = await getDb(c.env);
  const user = c.get("user");
  const limit = getRequestsPerMinuteLimit(user.plan);
  const count = await incrementRateLimitWindow(db, user.id, currentRateWindowKey());

  if (count > limit) {
    return c.json(
      {
        error: "rate_limited",
        message: `Rate limit exceeded for plan "${user.plan}".`,
        limit_per_minute: limit,
      },
      429,
    );
  }

  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await cleanupOldRateLimitWindows(db, cutoff);
  await next();
});

export const requireUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get("auth");
  if (auth.type !== "user") {
    return c.json({ error: "forbidden", message: "This endpoint requires a user API key." }, 403);
  }

  await next();
});

export function requireScopes(...requiredScopes: string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.get("auth");
    if (auth.type === "user") {
      await next();
      return;
    }

    const grantedScopes = new Set(auth.scopes);
    const missing = requiredScopes.filter((scope) => !grantedScopes.has(scope));
    if (missing.length > 0) {
      return c.json(
        {
          error: "forbidden",
          message: `Access token missing required scopes: ${missing.join(", ")}`,
        },
        403,
      );
    }

    await next();
  });
}
