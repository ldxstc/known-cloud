import { createMiddleware } from "hono/factory";

import { getDb, getUserByApiKey, type EnvBindings, type UserRow } from "./db";

export type AppEnv = {
  Bindings: EnvBindings;
  Variables: {
    user: UserRow;
  };
};

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!token) {
    return c.json({ error: "missing_authorization" }, 401);
  }

  const db = await getDb(c.env);
  const user = await getUserByApiKey(db, token);

  if (!user) {
    return c.json({ error: "invalid_api_key" }, 401);
  }

  c.set("user", user);
  await next();
});
