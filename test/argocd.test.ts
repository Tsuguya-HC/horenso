import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers.js";

const { sql, reset, request } = await loadApp();

before(reset);
beforeEach(reset);
after(() => sql.end());

const event = (app: string, ev: string, extra: Record<string, unknown> = {}) =>
  request("POST", "/events/argocd", { app, event: ev, ...extra });

const openTasks = () =>
  sql`SELECT id, title, tags FROM tasks WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY id`;

test("requires app and event", async () => {
  const res = await request("POST", "/events/argocd", { app: "web" });
  assert.equal(res.status, 400);
});

test("every event is recorded as an event post", async () => {
  const res = await event("web", "sync-succeeded", { sync_status: "Synced", health_status: "Healthy", message: "ok" });
  assert.equal(res.status, 201);
  const { post, task } = await res.json();
  assert.equal(post.type, "event");
  assert.equal(post.source, "argocd");
  assert.equal(post.context, "web");
  assert.deepEqual(post.tags, ["argocd", "sync-succeeded", "sync:Synced", "health:Healthy"]);
  assert.match(post.body, /\*\*Message\*\*: ok/);
  assert.equal(task, null);
});

test("a failure event opens one approved investigate task tagged app:<name>", async () => {
  const { task } = await (await event("web", "sync-failed", { message: "boom" })).json();
  assert.equal(task.status, "approved");
  assert.equal(task.category, "investigate");
  assert.equal(task.priority, "high");
  assert.deepEqual(task.tags, ["web", "app:web", "argocd", "sync-failed"]);

  const degraded = await (await event("other", "health-degraded")).json();
  assert.equal(degraded.task.priority, "normal");
});

test("a repeated failure for the same app does not open a second task", async () => {
  await event("web", "sync-failed");
  const second = await (await event("web", "sync-failed")).json();
  assert.equal(second.task, null);
  assert.equal((await openTasks()).length, 1);
});

test("the recovery event closes only the matching app and event", async () => {
  await event("web", "sync-failed");
  await event("web2", "sync-failed");
  await event("db", "health-degraded");

  const { resolved } = await (await event("web", "sync-succeeded")).json();
  assert.deepEqual(resolved.map((t: { title: string }) => t.title), ["web sync-failed 調査"]);
  assert.deepEqual((await openTasks()).map((t) => t.title), ["web2 sync-failed 調査", "db health-degraded 調査"]);

  // health-recovered on db closes the health task, sync-succeeded on db has nothing to close.
  assert.equal((await (await event("db", "sync-succeeded")).json()).resolved.length, 0);
  assert.equal((await (await event("db", "health-recovered")).json()).resolved.length, 1);
});

// 2026-08-23 の事故の回帰 (#81)。タグ配列には source の "argocd" も入っているので、
// 素のアプリ名で照合すると argocd という名前の Application が全タスクに一致する。
test("an Application named argocd recovering does not close other apps' tasks", async () => {
  await event("web", "health-degraded");
  const { resolved } = await (await event("argocd", "health-recovered")).json();
  assert.deepEqual(resolved, []);
  assert.equal((await openTasks()).length, 1);
});
