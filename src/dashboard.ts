import { Hono } from "hono";

import { countUserInsights, countUserNodes, getDb, getDeveloperById, getUserInsights, listActiveAccessGrants } from "./db";
import { getPlanLimits, syncUsagePeriod } from "./limits";
import { authMiddleware, rateLimitMiddleware, requireUserAuth } from "./middleware";
import type { AppEnv } from "./types";
import { escapeHtml } from "./utils";

export const dashboardRoutes = new Hono<AppEnv>();
dashboardRoutes.use("*", authMiddleware, rateLimitMiddleware, requireUserAuth);

dashboardRoutes.get("/", async (c) => {
  const db = await getDb(c.env);
  const user = await syncUsagePeriod(c, db);
  const [nodeCount, insightCount, insights, accessGrants] = await Promise.all([
    countUserNodes(db, user.id),
    countUserInsights(db, user.id),
    getUserInsights(db, user.id),
    listActiveAccessGrants(db, user.id),
  ]);

  const grants = await Promise.all(
    accessGrants.map(async (grant) => ({
      grant,
      developer: await getDeveloperById(db, grant.developer_id),
    })),
  );
  const limits = getPlanLimits(user.plan);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Known Cloud Dashboard</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --panel: #fffaf2;
        --border: #d6c7ae;
        --ink: #1e1b16;
        --muted: #6c6254;
        --accent: #a3522f;
      }
      body {
        margin: 0;
        font-family: Georgia, "Iowan Old Style", serif;
        background: radial-gradient(circle at top, #fff9ef, var(--bg));
        color: var(--ink);
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 40px 20px 80px;
      }
      .grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 18px;
        box-shadow: 0 12px 28px rgba(41, 29, 13, 0.08);
      }
      h1, h2 {
        margin: 0 0 12px;
      }
      h1 {
        font-size: 2.4rem;
      }
      h2 {
        font-size: 1.1rem;
        color: var(--accent);
      }
      p, li, td, th {
        line-height: 1.45;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        border-top: 1px solid var(--border);
        padding: 10px 0;
        text-align: left;
        vertical-align: top;
      }
      .muted {
        color: var(--muted);
      }
      ul {
        margin: 0;
        padding-left: 18px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Known Cloud</h1>
      <p class="muted">Brain ${escapeHtml(user.id)} on the ${escapeHtml(user.plan)} plan.</p>

      <section class="grid">
        <article class="card">
          <h2>Usage</h2>
          <p>Queries: ${user.usage_queries} / ${limits.queries}</p>
          <p>Ingestions: ${user.usage_ingestions} / ${limits.ingestions ?? "unlimited"}</p>
          <p>Period: ${escapeHtml(user.usage_period ?? "n/a")}</p>
        </article>
        <article class="card">
          <h2>Memory</h2>
          <p>Nodes: ${nodeCount}</p>
          <p>Insights: ${insightCount}</p>
        </article>
        <article class="card">
          <h2>Billing</h2>
          <p>Plan period end: ${escapeHtml(user.plan_period_end ?? "n/a")}</p>
          <p>Cancel at period end: ${user.cancel_at_period_end ? "yes" : "no"}</p>
        </article>
      </section>

      <section class="card" style="margin-top: 18px;">
        <h2>Access Grants</h2>
        <table>
          <thead>
            <tr><th>Developer</th><th>Scopes</th><th>Created</th></tr>
          </thead>
          <tbody>
            ${grants
              .map(
                ({ grant, developer }) => `<tr>
                  <td>${escapeHtml(developer?.name ?? grant.developer_id)}<div class="muted">${escapeHtml(developer?.website ?? "")}</div></td>
                  <td>${escapeHtml((JSON.parse(grant.scopes) as string[]).join(", "))}</td>
                  <td>${escapeHtml(grant.created_at)}</td>
                </tr>`,
              )
              .join("") || `<tr><td colspan="3" class="muted">No access grants.</td></tr>`}
          </tbody>
        </table>
      </section>

      <section class="card" style="margin-top: 18px;">
        <h2>Insights</h2>
        <ul>
          ${
            insights
              .slice(0, 20)
              .map(
                (insight) =>
                  `<li>${escapeHtml(insight.text)} <span class="muted">(${insight.confidence.toFixed(2)}, rediscovered ${insight.times_rediscovered}x)</span></li>`,
              )
              .join("") || `<li class="muted">No insights yet.</li>`
          }
        </ul>
      </section>
    </main>
  </body>
</html>`;

  return c.html(html);
});
