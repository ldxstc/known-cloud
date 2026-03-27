import { Hono } from "hono";

import { createDeveloper, getDb, getDeveloperById } from "./db";
import type { AppEnv } from "./types";

type RegisterDeveloperBody = {
  name?: string;
  website?: string;
  redirect_uri?: string;
};

export const developerRoutes = new Hono<AppEnv>();

developerRoutes.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => null)) as RegisterDeveloperBody | null;
  const name = body?.name?.trim();
  const website = body?.website?.trim();
  const redirectUri = body?.redirect_uri?.trim();

  if (!name || !website || !redirectUri) {
    return c.json({ error: "name, website, and redirect_uri are required" }, 400);
  }

  const db = await getDb(c.env);
  const developer = await createDeveloper(db, {
    name,
    website,
    redirectUri,
  });

  return c.json(
    {
      developer_id: developer.id,
      client_id: developer.client_id,
      client_secret: developer.client_secret,
    },
    201,
  );
});

developerRoutes.get("/:id", async (c) => {
  const developer = await getDeveloperById(await getDb(c.env), c.req.param("id"));
  if (!developer) {
    return c.json({ error: "developer_not_found" }, 404);
  }

  return c.json({
    id: developer.id,
    name: developer.name,
    website: developer.website,
    redirect_uri: developer.redirect_uri,
    client_id: developer.client_id,
    created_at: developer.created_at,
  });
});
