import { Hono, type Context } from "hono";
import Stripe from "stripe";

import { getDb, getUserByStripeCustomerId, getUserByStripeSubscriptionId, updateUserPlan, type UserRow } from "./db";
import { getPlanLimits, syncUsagePeriod } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import type { AppEnv } from "./types";
import { addDays, formatUsd, getNextResetIso } from "./utils";

type PlanName = "free" | "starter" | "pro";

type BillingPlanBody = {
  plan?: string;
};

const PAID_PLANS = {
  starter: {
    label: "Starter",
    amount: 900,
  },
  pro: {
    label: "Pro",
    amount: 2900,
  },
} satisfies Record<Exclude<PlanName, "free">, { label: string; amount: number }>;

function isPaidPlan(plan: string): plan is keyof typeof PAID_PLANS {
  return plan in PAID_PLANS;
}

function getStripe(env: AppEnv["Bindings"]) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is required.");
  }

  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function getBaseUrl(c: Context<AppEnv>) {
  return c.env.APP_BASE_URL?.trim() || new URL(c.req.url).origin;
}

async function ensurePlanProduct(stripe: Stripe, plan: keyof typeof PAID_PLANS) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.data.find((product) => product.metadata?.plan === plan);
  if (existing) {
    return existing.id;
  }

  const created = await stripe.products.create({
    name: `Known Cloud ${PAID_PLANS[plan].label}`,
    metadata: { plan },
  });

  return created.id;
}

async function buildSubscriptionPriceData(stripe: Stripe, plan: keyof typeof PAID_PLANS) {
  const productId = await ensurePlanProduct(stripe, plan);
  return {
    currency: "usd",
    product: productId,
    unit_amount: PAID_PLANS[plan].amount,
    recurring: {
      interval: "month" as const,
    },
  };
}

function planFromStripe(subscription: Stripe.Subscription, fallback: PlanName = "free"): PlanName {
  const metadataPlan = subscription.metadata?.plan;
  if (metadataPlan === "starter" || metadataPlan === "pro" || metadataPlan === "free") {
    return metadataPlan;
  }

  const amount = subscription.items.data[0]?.price?.unit_amount;
  if (amount === PAID_PLANS.starter.amount) {
    return "starter";
  }

  if (amount === PAID_PLANS.pro.amount) {
    return "pro";
  }

  return fallback;
}

function subscriptionPeriodEndIso(subscription: Stripe.Subscription) {
  return new Date(subscription.current_period_end * 1000).toISOString();
}

async function ensureCustomer(stripe: Stripe, db: Awaited<ReturnType<typeof getDb>>, user: UserRow) {
  if (user.stripe_customer_id) {
    return user.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    metadata: { user_id: user.id },
    name: user.device_name ?? undefined,
  });

  await updateUserPlan(db, {
    userId: user.id,
    plan: user.plan,
    stripeCustomerId: customer.id,
  });

  return customer.id;
}

async function syncUserFromSubscription(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  subscription: Stripe.Subscription,
  fallbackPlan: PlanName,
) {
  const nextPlan = planFromStripe(subscription, fallbackPlan);
  await updateUserPlan(db, {
    userId,
    plan: nextPlan,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    stripeSubscriptionId: subscription.id,
    planPeriodEnd: subscriptionPeriodEndIso(subscription),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });

  return nextPlan;
}

function computeOverage(usage: { queries: number; ingestions: number }, limits: ReturnType<typeof getPlanLimits>) {
  const queryOver = usage.queries > limits.queries;
  const ingestionOver = limits.ingestions === null ? false : usage.ingestions > limits.ingestions;
  return queryOver || ingestionOver;
}

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.post("/webhook", async (c) => {
  const stripe = getStripe(c.env);
  const signature = c.req.header("stripe-signature");
  if (!signature || !c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: "missing_webhook_signature" }, 400);
  }

  const payload = await c.req.text();
  const cryptoProvider = Stripe.createSubtleCryptoProvider();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch (error) {
    return c.json({ error: "invalid_webhook_signature", message: (error as Error).message }, 400);
  }

  const db = await getDb(c.env);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id ?? session.client_reference_id;
      const plan = (session.metadata?.plan as PlanName | undefined) ?? "starter";
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

      if (userId) {
        await updateUserPlan(db, {
          userId,
          plan,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          cancelAtPeriodEnd: false,
        });
      }
      break;
    }
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const user =
        (subscriptionId ? await getUserByStripeSubscriptionId(db, subscriptionId) : null) ??
        (customerId ? await getUserByStripeCustomerId(db, customerId) : null);

      if (user && subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await syncUserFromSubscription(db, user.id, subscription, user.plan as PlanName);
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
      if (subscriptionId) {
        const user = await getUserByStripeSubscriptionId(db, subscriptionId);
        if (user) {
          await updateUserPlan(db, {
            userId: user.id,
            plan: user.plan,
            stripeSubscriptionId: subscriptionId,
          });
        }
      }
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const user = await getUserByStripeSubscriptionId(db, subscription.id);
      if (user) {
        await updateUserPlan(db, {
          userId: user.id,
          plan: "free",
          stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
          stripeSubscriptionId: null,
          planPeriodEnd: subscriptionPeriodEndIso(subscription),
          cancelAtPeriodEnd: false,
        });
      }
      break;
    }
    default:
      break;
  }

  return c.json({ received: true });
});

billingRoutes.use("*", authMiddleware, rateLimitMiddleware, requireUserAuth);

billingRoutes.get("/status", async (c) => {
  const db = await getDb(c.env);
  const user = await syncUsagePeriod(c, db);
  const limits = getPlanLimits(user.plan);
  const usage = {
    queries: user.usage_queries,
    ingestions: user.usage_ingestions,
  };

  return c.json({
    plan: user.plan,
    usage,
    limits,
    overage: computeOverage(usage, limits),
    next_reset: getNextResetIso(),
  });
});

billingRoutes.post("/setup-intent", async (c) => {
  const body = (await c.req.json().catch(() => null)) as BillingPlanBody | null;
  const plan = body?.plan?.trim();

  if (!plan || !isPaidPlan(plan)) {
    return c.json({ error: "plan must be starter or pro" }, 400);
  }

  const stripe = getStripe(c.env);
  const db = await getDb(c.env);
  const user = c.get("user");
  const customerId = await ensureCustomer(stripe, db, user);
  const baseUrl = getBaseUrl(c);
  const priceData = await buildSubscriptionPriceData(stripe, plan);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    metadata: {
      user_id: user.id,
      plan,
    },
    subscription_data: {
      metadata: {
        user_id: user.id,
        plan,
      },
    },
    line_items: [
      {
        price_data: priceData,
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/dashboard?checkout=cancel`,
  });

  return c.json({
    checkout_url: session.url,
    session_id: session.id,
    plan,
    price: `${formatUsd(PAID_PLANS[plan].amount)}/month`,
  });
});

billingRoutes.post("/subscribe", async (c) => {
  const body = (await c.req.json().catch(() => null)) as BillingPlanBody | null;
  const requestedPlan = (body?.plan?.trim() ?? c.get("user").plan) as PlanName;
  const stripe = getStripe(c.env);
  const db = await getDb(c.env);
  const user = c.get("user");

  if (!user.stripe_customer_id) {
    return c.json({ error: "payment_method_required", message: "Run /billing/setup-intent first." }, 400);
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: user.stripe_customer_id,
    status: "all",
    limit: 10,
  });
  const subscription = subscriptions.data.find((candidate) => candidate.status !== "canceled" && candidate.status !== "incomplete_expired");

  if (!subscription) {
    return c.json({ error: "subscription_not_found", message: "Complete checkout before subscribing." }, 400);
  }

  const plan = await syncUserFromSubscription(db, user.id, subscription, requestedPlan === "free" ? "starter" : requestedPlan);
  return c.json({
    status: subscription.status,
    plan,
    current_period_end: subscriptionPeriodEndIso(subscription),
    limits: getPlanLimits(plan),
  });
});

billingRoutes.post("/upgrade", async (c) => {
  const body = (await c.req.json().catch(() => null)) as BillingPlanBody | null;
  const plan = body?.plan?.trim();

  if (!plan || !isPaidPlan(plan)) {
    return c.json({ error: "plan must be starter or pro" }, 400);
  }

  const stripe = getStripe(c.env);
  const db = await getDb(c.env);
  const user = c.get("user");
  if (!user.stripe_subscription_id) {
    return c.json({ error: "subscription_not_found" }, 400);
  }

  const subscription = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
  const currentItem = subscription.items.data[0];
  if (!currentItem) {
    return c.json({ error: "subscription_item_not_found" }, 400);
  }

  const priceData = await buildSubscriptionPriceData(stripe, plan);
  let proratedCharge: string | null = null;
  try {
    const preview = await stripe.invoices.createPreview({
      customer: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      subscription: subscription.id,
      subscription_details: {
        proration_behavior: "create_prorations",
        items: [
          {
            id: currentItem.id,
            quantity: 1,
            price_data: priceData,
          },
        ],
      },
    });
    proratedCharge = formatUsd(preview.amount_due ?? preview.total ?? null);
  } catch {
    proratedCharge = null;
  }

  const updated = await stripe.subscriptions.update(subscription.id, {
    cancel_at_period_end: false,
    proration_behavior: "create_prorations",
    metadata: {
      ...subscription.metadata,
      plan,
    },
    items: [
      {
        id: currentItem.id,
        quantity: 1,
        price_data: priceData,
      },
    ],
  });

  await syncUserFromSubscription(db, user.id, updated, plan);
  return c.json({
    status: updated.status,
    plan,
    prorated_charge: proratedCharge,
  });
});

billingRoutes.post("/cancel", async (c) => {
  const stripe = getStripe(c.env);
  const db = await getDb(c.env);
  const user = c.get("user");
  if (!user.stripe_subscription_id) {
    return c.json({ error: "subscription_not_found" }, 400);
  }

  const subscription = await stripe.subscriptions.update(user.stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  const activeUntil = subscriptionPeriodEndIso(subscription);
  await updateUserPlan(db, {
    userId: user.id,
    plan: user.plan,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    planPeriodEnd: activeUntil,
    cancelAtPeriodEnd: true,
  });

  return c.json({
    status: "canceling",
    active_until: activeUntil,
    data_retained_until: addDays(activeUntil, 90),
  });
});
