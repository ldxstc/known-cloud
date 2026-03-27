import { Hono } from "hono";

import { createApiKey } from "./ids";
import { createUser, getDb, getUserByDeviceId } from "./db";
import { getPlanLimits, getUsagePeriod } from "./limits";
import type { AppEnv } from "./middleware";

type AutoProvisionBody = {
  agent_platform?: string;
  device_id?: string;
  device_name?: string;
};

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/auto-provision", async (c) => {
  const body = (await c.req.json().catch(() => null)) as AutoProvisionBody | null;
  const agentPlatform = body?.agent_platform?.trim();
  const deviceId = body?.device_id?.trim();
  const deviceName = body?.device_name?.trim();

  if (!agentPlatform || !deviceId) {
    return c.json({ error: "agent_platform and device_id are required" }, 400);
  }

  const db = await getDb(c.env);
  const existing = await getUserByDeviceId(db, deviceId);
  if (existing) {
    return c.json(
      {
        user_id: existing.id,
        api_key: existing.api_key,
        brain_id: existing.id,
        plan: existing.plan,
        limits: getPlanLimits(existing.plan),
      },
      200,
    );
  }

  const createdAt = new Date().toISOString();

  try {
    const user = await createUser(db, {
      agentPlatform,
      apiKey: createApiKey(),
      createdAt,
      deviceId,
      deviceName,
      usagePeriod: getUsagePeriod(),
    });

    return c.json(
      {
        user_id: user.id,
        api_key: user.api_key,
        brain_id: user.id,
        plan: user.plan,
        limits: getPlanLimits(user.plan),
      },
      201,
    );
  } catch (error) {
    const recovered = await getUserByDeviceId(db, deviceId);
    if (recovered) {
      return c.json(
        {
          user_id: recovered.id,
          api_key: recovered.api_key,
          brain_id: recovered.id,
          plan: recovered.plan,
          limits: getPlanLimits(recovered.plan),
        },
        200,
      );
    }

    throw error;
  }
});
