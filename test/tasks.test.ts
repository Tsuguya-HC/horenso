import { test, before, beforeEach, afterEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { loadApp, startReceiver, waitFor, settle } from "./helpers.js";

const dispatch = await startReceiver();
const discord = await startReceiver();
const { sql, reset, request } = await loadApp({
  TASK_DISPATCH_URL: `${dispatch.url}/task`,
  DISCORD_WEBHOOK_URL: `${discord.url}/webhook`,
});

before(reset);
beforeEach(async () => {
  await reset();
  dispatch.received.length = 0;
  discord.received.length = 0;
});
afterEach(() => {
  dispatch.state.status = 200;
  discord.state.status = 200;
  mock.restoreAll();
});
after(async () => {
  await sql.end();
  await dispatch.close();
  await discord.close();
});

const create = async (fields: Record<string, unknown>) => {
  const res = await request("POST", "/tasks", { title: "t", description: "d", category: "observe", ...fields });
  assert.equal(res.status, 201);
  return res.json();
};

test("POST /tasks validates required fields, category and priority", async () => {
  assert.equal((await request("POST", "/tasks", { title: "t", category: "observe" })).status, 400);
  assert.equal((await request("POST", "/tasks", { title: "t", description: "d", category: "nope" })).status, 400);
  assert.equal(
    (await request("POST", "/tasks", { title: "t", description: "d", category: "observe", priority: "urgent" })).status,
    400,
  );
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM tasks`;
  assert.equal(count, 0);
});

test("POST /tasks defaults to pending / normal / claude-code and dispatches nothing", async () => {
  const task = await create({});
  assert.equal(task.status, "pending");
  assert.equal(task.priority, "normal");
  assert.equal(task.source, "claude-code");
  await settle();
  assert.equal(dispatch.received.length, 0);
  assert.equal(discord.received.length, 0);
});

test("an approved task is dispatched to TASK_DISPATCH_URL", async () => {
  const task = await create({ status: "approved", priority: "high", tags: ["x"] });
  await waitFor(() => dispatch.received.length === 1);
  assert.deepEqual(dispatch.received[0], {
    path: "/task",
    body: { id: task.id, title: "t", description: "d", category: "observe", priority: "high", tags: ["x"] },
  });
});

test("an approved adjudicate task goes to the /adjudicate endpoint", async () => {
  await create({ status: "approved", category: "adjudicate", description: "which one?", workflow_name: "wf-1" });
  await waitFor(() => dispatch.received.length === 1);
  assert.deepEqual(dispatch.received[0], {
    path: "/adjudicate",
    body: { context: "which one?", source_workflow: "wf-1", source_namespace: "claude-code" },
  });
});

test("a task waiting for approval is announced on Discord, not dispatched", async () => {
  const task = await create({ status: "waiting_approval", decision: "ask", decision_reason: "risky" });
  await waitFor(() => discord.received.length === 1);
  const [embed] = discord.received[0].body.embeds as Record<string, unknown>[];
  assert.match(String(embed.title), /承認待ちタスク: t/);
  assert.deepEqual(embed.footer, { text: `Task #${task.id}` });
  await settle();
  assert.equal(dispatch.received.length, 0);
});

test("PATCH to approved dispatches once; later updates do not re-dispatch", async () => {
  const task = await create({ status: "waiting_approval" });
  const approved = await request("PATCH", `/tasks/${task.id}`, { status: "approved" });
  assert.equal(approved.status, 200);
  await waitFor(() => dispatch.received.length === 1);

  await request("PATCH", `/tasks/${task.id}`, { status: "approved" });
  await request("PATCH", `/tasks/${task.id}`, { status: "running", workflow_name: "wf-9" });
  const done = await (await request("PATCH", `/tasks/${task.id}`, { status: "completed", result: "ok" })).json();
  assert.equal(done.status, "completed");
  assert.equal(done.result, "ok");
  assert.equal(done.workflow_name, "wf-9");
  await settle();
  assert.equal(dispatch.received.length, 1);
});

test("PATCH validates status and 404s on a missing task", async () => {
  const task = await create({});
  assert.equal((await request("PATCH", `/tasks/${task.id}`, { status: "done" })).status, 400);
  assert.equal((await request("PATCH", "/tasks/999", { status: "approved" })).status, 404);
});

test("GET /tasks filters by status, category and tag", async () => {
  await create({ title: "a", status: "pending", category: "observe", tags: ["x"] });
  await create({ title: "b", status: "pending", category: "investigate" });
  await create({ title: "c", status: "completed", category: "observe", tags: ["x"] });
  const titles = async (q: string) =>
    ((await (await request("GET", `/tasks${q}`)).json()) as { title: string }[]).map((t) => t.title).sort();

  assert.deepEqual(await titles(""), ["a", "b", "c"]);
  assert.deepEqual(await titles("?status=pending"), ["a", "b"]);
  assert.deepEqual(await titles("?status=pending&category=observe"), ["a"]);
  assert.deepEqual(await titles("?category=observe"), ["a", "c"]);
  assert.deepEqual(await titles("?tag=x"), ["a", "c"]);
  assert.deepEqual(await titles("?status=completed&tag=x"), ["c"]);
});

test("GET /tasks/:id and /tasks/:id/posts", async () => {
  const task = await create({});
  assert.equal((await (await request("GET", `/tasks/${task.id}`)).json()).title, "t");
  assert.equal((await request("GET", "/tasks/999")).status, 404);

  await request("POST", "/posts", { type: "report", source: "s", context: String(task.id), body: "feedback" });
  await request("POST", "/posts", { type: "report", source: "s", context: "other", body: "unrelated" });
  const posts = await (await request("GET", `/tasks/${task.id}/posts`)).json();
  assert.deepEqual(posts.map((p: { body: string }) => p.body), ["feedback"]);
});

// 投げっぱなしの送信でも、相手が受け取らなかったことはログに残す。fetch は
// HTTP エラーでは reject しないので、ステータスを見ないと 500 が成功に見える。
const errorLogs = () => {
  const spy = mock.method(console, "error", () => {});
  return () => spy.mock.calls.map((call) => call.arguments.map(String).join(" "));
};

test("a dispatch endpoint answering with an HTTP error is logged", async () => {
  const logs = errorLogs();
  dispatch.state.status = 500;
  const task = await create({ status: "approved" });
  await waitFor(() => dispatch.received.length === 1);
  await waitFor(() => logs().length > 0);
  assert.match(logs().join("\n"), new RegExp(`task #${task.id}.*500`));
});

test("a Discord webhook answering with an HTTP error is logged", async () => {
  const logs = errorLogs();
  discord.state.status = 400;
  const task = await create({ status: "waiting_approval" });
  await waitFor(() => discord.received.length === 1);
  await waitFor(() => logs().length > 0);
  assert.match(logs().join("\n"), new RegExp(`task #${task.id}.*400`));
});
