import { Hono } from "hono";
import { cors } from "hono/cors";

import { accessRoutes } from "./access";
import { authRoutes } from "./auth";
import { billingRoutes } from "./billing";
import { dashboardRoutes } from "./dashboard";
import { developerRoutes } from "./developers";
import { discoverRoutes } from "./discover";
import { expandRoutes } from "./expand";
import { forgetRoutes } from "./forget";
import { grepRoutes } from "./grep";
import { ingestRoutes } from "./ingest";
import { insightRoutes } from "./insights";
import { migrateRoutes } from "./migrate";
import { rememberRoutes } from "./remember";
import { searchRoutes } from "./search";
import { statsRoutes } from "./stats";
import type { AppEnv } from "./types";
import { understandRoutes } from "./understand";

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type", "Stripe-Signature"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);

app.get("/", (c) =>
  c.json({
    service: "known-cloud",
    version: "week-7",
  }),
);

app.route("/auth", authRoutes);
app.route("/access", accessRoutes);
app.route("/ingest", ingestRoutes);
app.route("/grep", grepRoutes);
app.route("/expand", expandRoutes);
app.route("/understand", understandRoutes);
app.route("/search", searchRoutes);
app.route("/stats", statsRoutes);
app.route("/remember", rememberRoutes);
app.route("/forget", forgetRoutes);
app.route("/discover", discoverRoutes);
app.route("/insights", insightRoutes);
app.route("/billing", billingRoutes);
app.route("/developers", developerRoutes);
app.route("/migrate", migrateRoutes);
app.route("/dashboard", dashboardRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json(
    {
      error: "internal_error",
      message: error.message,
    },
    500,
  );
});

export default app;
