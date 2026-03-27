import { Hono } from "hono";

import { createApiKey, createLinkCode } from "./ids";
import {
  countActiveApiKeys,
  createApiKeyRecord,
  createDeviceLinkCode,
  createUser,
  getActiveApiKeyByDeviceId,
  getDb,
  getUserByDeviceId,
  getUserById,
  revokeApiKey,
  listActiveApiKeys,
  getActiveDeviceLinkCode,
  consumeDeviceLinkCode,
} from "./db";
import { getPlanLimits, getUsagePeriod } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import type { AppEnv } from "./types";

type AutoProvisionBody = {
  agent_platform?: string;
  device_id?: string;
  device_name?: string;
};

type LinkConfirmBody = {
  code?: string;
  device_id?: string;
  device_name?: string;
  agent_platform?: string;
};

type CreateKeyBody = {
  device_id?: string;
  device_name?: string;
  agent_platform?: string;
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
  const existingApiKey = await getActiveApiKeyByDeviceId(db, deviceId);
  if (existingApiKey) {
    const user = await getUserById(db, existingApiKey.user_id);
    if (!user) {
      return c.json({ error: "device_exists_without_user" }, 409);
    }

    return c.json(
      {
        user_id: user.id,
        api_key: existingApiKey.key_value,
        brain_id: user.id,
        plan: user.plan,
        limits: getPlanLimits(user.plan),
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
    const recoveredApiKey = await getActiveApiKeyByDeviceId(db, deviceId);
    if (recoveredApiKey) {
      const recoveredUser = await getUserById(db, recoveredApiKey.user_id);
      if (recoveredUser) {
        return c.json(
          {
            user_id: recoveredUser.id,
            api_key: recoveredApiKey.key_value,
            brain_id: recoveredUser.id,
            plan: recoveredUser.plan,
            limits: getPlanLimits(recoveredUser.plan),
          },
          200,
        );
      }
    }

    throw error;
  }
});

authRoutes.use("/link-request", authMiddleware, rateLimitMiddleware, requireUserAuth);
authRoutes.post("/link-request", async (c) => {
  const db = await getDb(c.env);
  const code = createLinkCode();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await createDeviceLinkCode(db, {
    code,
    userId: c.get("user").id,
    expiresAt,
  });

  return c.json({
    code,
    expires_in: 300,
  });
});

authRoutes.post("/link-confirm", async (c) => {
  const body = (await c.req.json().catch(() => null)) as LinkConfirmBody | null;
  const code = body?.code?.trim();
  const deviceId = body?.device_id?.trim();
  const deviceName = body?.device_name?.trim();
  const agentPlatform = body?.agent_platform?.trim();

  if (!code || !deviceId) {
    return c.json({ error: "code and device_id are required" }, 400);
  }

  const db = await getDb(c.env);
  const linkCode = await getActiveDeviceLinkCode(db, code);
  if (!linkCode || new Date(linkCode.expires_at).getTime() < Date.now()) {
    return c.json({ error: "invalid_or_expired_code" }, 400);
  }

  const existingOwner = await getUserByDeviceId(db, deviceId);
  if (existingOwner && existingOwner.id !== linkCode.user_id) {
    return c.json({ error: "device_already_linked" }, 409);
  }

  const existingKey = await getActiveApiKeyByDeviceId(db, deviceId);
  if (existingKey && existingKey.user_id === linkCode.user_id) {
    await consumeDeviceLinkCode(db, code);
    return c.json({
      api_key: existingKey.key_value,
      brain_id: linkCode.user_id,
    });
  }

  const apiKey = await createApiKeyRecord(db, {
    userId: linkCode.user_id,
    keyValue: createApiKey(),
    deviceId,
    deviceName,
    agentPlatform,
  });
  await consumeDeviceLinkCode(db, code);

  return c.json({
    api_key: apiKey.key_value,
    brain_id: linkCode.user_id,
  });
});

authRoutes.use("/keys", authMiddleware, rateLimitMiddleware, requireUserAuth);

authRoutes.get("/keys", async (c) => {
  const db = await getDb(c.env);
  const keys = await listActiveApiKeys(db, c.get("user").id);
  return c.json({
    keys: keys.map((key) => ({
      id: key.id,
      device_id: key.device_id,
      device_name: key.device_name,
      agent_platform: key.agent_platform,
      created_at: key.created_at,
      last_used_at: key.last_used_at,
    })),
  });
});

authRoutes.post("/keys", async (c) => {
  const body = (await c.req.json().catch(() => null)) as CreateKeyBody | null;
  const db = await getDb(c.env);
  const deviceId = body?.device_id?.trim();
  const deviceName = body?.device_name?.trim();
  const agentPlatform = body?.agent_platform?.trim();

  if (deviceId) {
    const existingUser = await getUserByDeviceId(db, deviceId);
    if (existingUser && existingUser.id !== c.get("user").id) {
      return c.json({ error: "device_already_linked" }, 409);
    }

    const existingKey = await getActiveApiKeyByDeviceId(db, deviceId);
    if (existingKey && existingKey.user_id === c.get("user").id) {
      return c.json(
        {
          key_id: existingKey.id,
          api_key: existingKey.key_value,
          created_at: existingKey.created_at,
        },
        200,
      );
    }
  }

  const created = await createApiKeyRecord(db, {
    userId: c.get("user").id,
    keyValue: createApiKey(),
    deviceId,
    deviceName,
    agentPlatform,
  });

  return c.json(
    {
      key_id: created.id,
      api_key: created.key_value,
      created_at: created.created_at,
      device_id: created.device_id,
      device_name: created.device_name,
      agent_platform: created.agent_platform,
    },
    201,
  );
});

authRoutes.delete("/keys/:keyId", async (c) => {
  const keyId = c.req.param("keyId");
  const db = await getDb(c.env);
  const activeKeyCount = await countActiveApiKeys(db, c.get("user").id);

  if (activeKeyCount <= 1) {
    return c.json({ error: "cannot_revoke_last_key" }, 400);
  }

  const revoked = await revokeApiKey(db, c.get("user").id, keyId);
  if (revoked === 0) {
    return c.json({ error: "key_not_found" }, 404);
  }

  return c.json({ revoked: true, key_id: keyId });
});
