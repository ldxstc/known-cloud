import { Hono } from "hono";

import { getDb, grepUserMessages } from "./db";
import { ensureWithinLimit, recordUsage } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireScopes } from "./middleware";
import type { AppEnv } from "./types";

function buildSnippet(text: string, query: string) {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);
  if (matchIndex === -1) {
    return text.slice(0, 100);
  }

  const start = Math.max(0, matchIndex - 50);
  const end = Math.min(text.length, matchIndex + query.length + 50);
  return text.slice(start, end);
}

export const grepRoutes = new Hono<AppEnv>();
grepRoutes.use("*", authMiddleware, rateLimitMiddleware, requireScopes("search"));

grepRoutes.get("/", async (c) => {
  const query = c.req.query("q")?.trim();
  const limitParam = c.req.query("limit");
  const limit = Math.min(Math.max(Number(limitParam ?? "10") || 10, 1), 50);

  if (!query) {
    return c.json({ error: "q is required" }, 400);
  }

  const db = await getDb(c.env);
  const limitResponse = await ensureWithinLimit(c, db, "queries");
  if (limitResponse) {
    return limitResponse;
  }

  const messages = await grepUserMessages(db, c.get("user").id, query, limit);
  await recordUsage(c, db, "queries");

  return c.json({
    results: messages.map((message) => ({
      id: message.id,
      source: message.source,
      session_id: message.session_id,
      created_at: message.created_at,
      snippet: buildSnippet(message.text, query),
    })),
  });
});
