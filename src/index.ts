import { Hono } from "hono";
import { cors } from "hono/cors";

import { authRoutes } from "./auth";
import { forgetRoutes } from "./forget";
import { ingestRoutes } from "./ingest";
import { rememberRoutes } from "./remember";
import { searchRoutes } from "./search";
import { statsRoutes } from "./stats";
import { understandRoutes } from "./understand";
import type { AppEnv } from "./middleware";

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);

app.get("/", (c) =>
  c.json({
    service: "known-cloud",
    version: "week-1",
  }),
);

app.route("/auth", authRoutes);
app.route("/ingest", ingestRoutes);
app.route("/understand", understandRoutes);
app.route("/search", searchRoutes);
app.route("/stats", statsRoutes);
app.route("/remember", rememberRoutes);
app.route("/forget", forgetRoutes);

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
