import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers.js";

const { sql, reset, request } = await loadApp();

before(reset);
beforeEach(reset);
after(() => sql.end());

const maintenance = async (body?: unknown) => {
  const res = await request("POST", "/maintenance", body);
  assert.equal(res.status, 200);
  return res.json();
};

test("an empty run still posts a report, so silence and health stay distinguishable", async () => {
  const summary = await maintenance();
  assert.deepEqual(summary, {
    apps_checked: 0, resolved: [], failed_stale_running: [], stale_open: [], purged_events: 0,
  });
  const reports = await sql`SELECT * FROM posts WHERE source = 'maintenance'`;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].type, "report");
  assert.deepEqual(reports[0].tags, ["maintenance"]);
});

test("closes argocd tasks whose app is now Healthy / Synced, and only those", async () => {
  await request("POST", "/events/argocd", { app: "web", event: "health-degraded" });
  await request("POST", "/events/argocd", { app: "api", event: "sync-failed" });
  await request("POST", "/events/argocd", { app: "db", event: "health-degraded" });

  const summary = await maintenance({
    apps: [
      { name: "web", health: "Healthy", sync: "OutOfSync" },
      { name: "api", health: "Degraded", sync: "Synced" },
      { name: "db", health: "Degraded", sync: "Synced" },
      // 名前の無いエントリが混じっていても落ちない
      { health: "Healthy" },
    ],
  });
  assert.equal(summary.apps_checked, 4);
  assert.deepEqual(summary.resolved, ["#1 web health-degraded 調査", "#2 api sync-failed 調査"]);
  const [db] = await sql`SELECT status FROM tasks WHERE id = 3`;
  assert.equal(db.status, "approved");
});

test("an Application named argocd being Healthy does not close other apps' tasks", async () => {
  await request("POST", "/events/argocd", { app: "web", event: "health-degraded" });
  const summary = await maintenance({ apps: [{ name: "argocd", health: "Healthy", sync: "Synced" }] });
  assert.deepEqual(summary.resolved, []);
});

test("fails tasks stuck in running, and lists long-open ones without touching them", async () => {
  await sql`
    INSERT INTO tasks (title, description, category, status, updated_at) VALUES
      ('stuck',   'd', 'observe', 'running',  NOW() - interval '25 hours'),
      ('busy',    'd', 'observe', 'running',  NOW() - interval '1 hour'),
      ('waiting', 'd', 'observe', 'waiting_approval', NOW() - interval '8 days'),
      ('fresh',   'd', 'observe', 'pending',  NOW())
  `;
  const summary = await maintenance();
  assert.deepEqual(summary.failed_stale_running, ["#1 stuck"]);
  assert.equal(summary.stale_open.length, 1);
  assert.match(summary.stale_open[0], /^#3 \[waiting_approval\] waiting /);

  const rows = await sql`SELECT title, status FROM tasks ORDER BY id`;
  assert.deepEqual(rows.map((r) => [r.title, r.status]), [
    ["stuck", "failed"], ["busy", "running"], ["waiting", "waiting_approval"], ["fresh", "pending"],
  ]);
});

test("purges old event posts but keeps handover notes of any age", async () => {
  await sql`
    INSERT INTO posts (type, source, body, created_at) VALUES
      ('event',  'argocd', 'old event', NOW() - interval '31 days'),
      ('event',  'argocd', 'new event', NOW() - interval '1 day'),
      ('report', 'agent',  'old note',  NOW() - interval '90 days')
  `;
  const summary = await maintenance();
  assert.equal(summary.purged_events, 1);
  const left = await sql`SELECT body FROM posts WHERE source <> 'maintenance' ORDER BY id`;
  assert.deepEqual(left.map((r) => r.body), ["new event", "old note"]);
});
