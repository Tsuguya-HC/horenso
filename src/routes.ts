import { Hono } from "hono";
import { sql } from "./db.js";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof SyntaxError) {
    console.warn(
      `[400] malformed JSON: ${c.req.method} ${c.req.path} ` +
        `ua="${c.req.header("user-agent") ?? "-"}" xff="${c.req.header("x-forwarded-for") ?? "-"}": ${err.message}`,
    );
    return c.json({ error: "invalid JSON body" }, 400);
  }
  console.error(`[500] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "internal server error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));

app.post("/posts", async (c) => {
  const { type, source, context, body, tags } = await c.req.json();

  if (!type || !source || !body) {
    return c.json({ error: "type, source, body are required" }, 400);
  }
  if (!["report", "update", "question", "event"].includes(type)) {
    return c.json({ error: "type must be report, update, question, or event" }, 400);
  }

  const [post] = await sql`
    INSERT INTO posts (type, source, context, body, tags)
    VALUES (${type}, ${source}, ${context ?? null}, ${body}, ${tags ?? []})
    RETURNING *
  `;
  return c.json(post, 201);
});

app.get("/posts", async (c) => {
  const tag = c.req.query("tag");
  const source = c.req.query("source");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const before = c.req.query("before");

  const conditions = [];
  const params: Record<string, unknown> = {};

  let posts;

  if (tag && before) {
    posts = await sql`
      SELECT * FROM posts
      WHERE ${tag}::text = ANY(tags) AND created_at < ${before}
      ${source ? sql`AND source = ${source}` : sql``}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (tag) {
    posts = await sql`
      SELECT * FROM posts
      WHERE ${tag}::text = ANY(tags)
      ${source ? sql`AND source = ${source}` : sql``}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (before) {
    posts = await sql`
      SELECT * FROM posts
      WHERE created_at < ${before}
      ${source ? sql`AND source = ${source}` : sql``}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (source) {
    posts = await sql`
      SELECT * FROM posts
      WHERE source = ${source}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    posts = await sql`
      SELECT * FROM posts
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json(posts);
});

app.get("/posts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [post] = await sql`SELECT * FROM posts WHERE id = ${id}`;
  if (!post) return c.json({ error: "not found" }, 404);
  return c.json(post);
});

// --- Events API (ArgoCD Notifications webhook) ---

app.post("/events/argocd", async (c) => {
  const { app: appName, event, sync_status, health_status, message, url } = await c.req.json();

  if (!appName || !event) {
    return c.json({ error: "app and event are required" }, 400);
  }

  const tags = ["argocd", event];
  if (sync_status) tags.push(`sync:${sync_status}`);
  if (health_status) tags.push(`health:${health_status}`);

  const body = [
    `**App**: ${appName}`,
    `**Event**: ${event}`,
    sync_status ? `**Sync**: ${sync_status}` : null,
    health_status ? `**Health**: ${health_status}` : null,
    message ? `**Message**: ${message}` : null,
    url ? `**URL**: ${url}` : null,
  ].filter(Boolean).join("\n");

  const [post] = await sql`
    INSERT INTO posts (type, source, context, body, tags)
    VALUES ('event', 'argocd', ${appName}, ${body}, ${tags})
    RETURNING *
  `;

  const isFailed = event === "sync-failed" || event === "health-degraded";
  let task = null;
  let resolved: Record<string, unknown>[] = [];

  const recoveredFrom =
    event === "sync-succeeded" ? "sync-failed"
    : event === "health-recovered" ? "health-degraded"
    : null;

  if (recoveredFrom) {
    resolved = await sql`
      UPDATE tasks
      SET status = 'completed',
          result = ${`resolved by ArgoCD ${event} event`},
          updated_at = NOW()
      WHERE source = 'argocd'
        AND tags @> ARRAY[${`app:${appName}`}, ${recoveredFrom}]::text[]
        AND status NOT IN ('completed', 'failed', 'cancelled')
      RETURNING id, title
    `;
  }

  if (isFailed) {
    const [existing] = await sql`
      SELECT id FROM tasks
      WHERE source = 'argocd' AND tags @> ARRAY[${appName}]::text[]
        AND status NOT IN ('completed', 'failed', 'cancelled')
      LIMIT 1
    `;

    if (!existing) {
      [task] = await sql`
        INSERT INTO tasks (title, description, category, priority, source, tags,
                           status, decision, decision_reason)
        VALUES (
          ${`${appName} ${event} 調査`},
          ${`ArgoCD ${event}: ${appName}\n${message ?? ""}\n${url ?? ""}`},
          'investigate',
          ${event === "sync-failed" ? "high" : "normal"},
          'argocd',
          ${[appName, `app:${appName}`, "argocd", event]},
          'approved',
          'auto',
          'ArgoCD failed/degraded イベントによる自動タスク作成'
        )
        RETURNING *
      `;
    }
  }

  return c.json({ post, task, resolved }, 201);
});

// argocd 由来タスクの app 照合は `app:<name>` タグで行う。素のタグ配列には
// "argocd" (source) も入っているので、`argocd` という名前の Application が
// Healthy になった瞬間に全タスクへ一致してしまう (2026-08-23 に実際に起きた)。

// --- Maintenance ---
//
// 日次の整理。判断は全て決定的で、LLM は使わない。
// ArgoCD の現状は呼び出し側 (CronWorkflow) が kubectl で集めて渡す。
// horenso 自身に ArgoCD の読み取り権限を持たせない。
//
// 1. 回復イベントを取りこぼした argocd 由来タスクを現状と突き合わせて閉じる
// 2. running のまま更新が止まったタスクを failed にする
// 3. 古い event 投稿を削除する (report/update/question は引き継ぎノートなので残す)
// 4. 結果を report として投稿する (0 件でも投稿する — 沈黙と正常を区別するため)

const EVENT_RETENTION_DAYS = parseInt(process.env.EVENT_RETENTION_DAYS ?? "30");
const RUNNING_STALE_HOURS = parseInt(process.env.RUNNING_STALE_HOURS ?? "24");
const OPEN_STALE_DAYS = parseInt(process.env.OPEN_STALE_DAYS ?? "7");

app.post("/maintenance", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const apps: { name: string; health?: string; sync?: string }[] = Array.isArray(body.apps) ? body.apps : [];

  const resolved: { id: number; title: string }[] = [];
  for (const a of apps) {
    if (!a?.name) continue;
    const closeEvents: string[] = [];
    if (a.health === "Healthy") closeEvents.push("health-degraded");
    if (a.sync === "Synced") closeEvents.push("sync-failed");
    for (const ev of closeEvents) {
      const rows = await sql`
        UPDATE tasks
        SET status = 'completed',
            result = ${`resolved: ${a.name} is ${ev === "health-degraded" ? "Healthy" : "Synced"} (maintenance reconcile)`},
            updated_at = NOW()
        WHERE source = 'argocd'
          AND tags @> ARRAY[${`app:${a.name}`}, ${ev}]::text[]
          AND status NOT IN ('completed', 'failed', 'cancelled')
        RETURNING id, title
      `;
      resolved.push(...(rows as unknown as { id: number; title: string }[]));
    }
  }

  const staleRunning = await sql`
    UPDATE tasks
    SET status = 'failed',
        result = ${`no status update for ${RUNNING_STALE_HOURS}h while running (maintenance)`},
        updated_at = NOW()
    WHERE status = 'running'
      AND updated_at < NOW() - ${`${RUNNING_STALE_HOURS} hours`}::interval
    RETURNING id, title
  `;

  const staleOpen = await sql`
    SELECT id, title, status, source, created_at FROM tasks
    WHERE status IN ('pending', 'approved', 'waiting_approval')
      AND updated_at < NOW() - ${`${OPEN_STALE_DAYS} days`}::interval
    ORDER BY created_at
  `;

  const purged = await sql`
    DELETE FROM posts
    WHERE type = 'event'
      AND created_at < NOW() - ${`${EVENT_RETENTION_DAYS} days`}::interval
    RETURNING id
  `;

  const summary = {
    apps_checked: apps.length,
    resolved: resolved.map((t) => `#${t.id} ${t.title}`),
    failed_stale_running: staleRunning.map((t) => `#${t.id} ${t.title}`),
    stale_open: staleOpen.map((t) => `#${t.id} [${t.status}] ${t.title} (${String(t.created_at).slice(0, 10)})`),
    purged_events: purged.length,
  };

  const lines = [
    `**ArgoCD apps checked**: ${summary.apps_checked}`,
    `**Resolved**: ${summary.resolved.length}`,
    ...summary.resolved.map((s) => `- ${s}`),
    `**Failed (stale running)**: ${summary.failed_stale_running.length}`,
    ...summary.failed_stale_running.map((s) => `- ${s}`),
    `**Still open > ${OPEN_STALE_DAYS}d**: ${summary.stale_open.length}`,
    ...summary.stale_open.map((s) => `- ${s}`),
    `**Purged event posts (> ${EVENT_RETENTION_DAYS}d)**: ${summary.purged_events}`,
  ];

  await sql`
    INSERT INTO posts (type, source, context, body, tags)
    VALUES ('report', 'maintenance', 'maintenance', ${lines.join("\n")}, ${["maintenance"]})
  `;

  return c.json(summary);
});

// --- Tasks API ---

const VALID_STATUSES = ["pending", "approved", "running", "waiting_approval", "completed", "failed", "cancelled"] as const;
const VALID_PRIORITIES = ["low", "normal", "high", "critical"] as const;
const VALID_CATEGORIES = ["investigate", "modify_manifest", "modify_infra", "modify_cloudflare", "operate", "observe", "adjudicate"] as const;

app.post("/tasks", async (c) => {
  const reqBody = await c.req.json();
  const { title, description, category, priority, source, parent_task_id, tags, workflow_name } = reqBody;

  if (!title || !description || !category) {
    return c.json({ error: "title, description, category are required" }, 400);
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return c.json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` }, 400);
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    return c.json({ error: `priority must be one of: ${VALID_PRIORITIES.join(", ")}` }, 400);
  }

  const [task] = await sql`
    INSERT INTO tasks (title, description, category, priority, source, parent_task_id, tags,
                       workflow_name, status, decision, decision_reason)
    VALUES (
      ${title},
      ${description},
      ${category},
      ${priority ?? "normal"},
      ${source ?? "claude-code"},
      ${parent_task_id ?? null},
      ${tags ?? []},
      ${workflow_name ?? null},
      ${reqBody.status ?? "pending"},
      ${reqBody.decision ?? null},
      ${reqBody.decision_reason ?? null}
    )
    RETURNING *
  `;

  if (task.status === "waiting_approval" && DISCORD_WEBHOOK_URL) {
    notifyDiscord(task).catch(() => {});
  }

  if (task.status === "approved") {
    dispatchTask(task).catch((e) => console.error("dispatch error:", e));
  }

  return c.json(task, 201);
});

app.get("/tasks", async (c) => {
  const status = c.req.query("status");
  const category = c.req.query("category");
  const tag = c.req.query("tag");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);

  if (status && tag) {
    const tasks = await sql`
      SELECT * FROM tasks WHERE status = ${status} AND ${tag}::text = ANY(tags)
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return c.json(tasks);
  } else if (status) {
    const tasks = await sql`
      SELECT * FROM tasks WHERE status = ${status}
      ${category ? sql`AND category = ${category}` : sql``}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return c.json(tasks);
  } else if (category) {
    const tasks = await sql`
      SELECT * FROM tasks WHERE category = ${category}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return c.json(tasks);
  } else if (tag) {
    const tasks = await sql`
      SELECT * FROM tasks WHERE ${tag}::text = ANY(tags)
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return c.json(tasks);
  } else {
    const tasks = await sql`
      SELECT * FROM tasks ORDER BY created_at DESC LIMIT ${limit}
    `;
    return c.json(tasks);
  }
});

app.get("/tasks/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [task] = await sql`SELECT * FROM tasks WHERE id = ${id}`;
  if (!task) return c.json({ error: "not found" }, 404);
  return c.json(task);
});

app.patch("/tasks/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json();

  const [existing] = await sql`SELECT * FROM tasks WHERE id = ${id}`;
  if (!existing) return c.json({ error: "not found" }, 404);

  if (body.status) {
    if (!VALID_STATUSES.includes(body.status)) {
      return c.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, 400);
    }
  }

  const [updated] = await sql`
    UPDATE tasks SET
      status = ${body.status ?? existing.status},
      result = ${body.result ?? existing.result},
      workflow_name = ${body.workflow_name ?? existing.workflow_name},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;

  if (updated.status === "approved" && existing.status !== "approved") {
    dispatchTask(updated).catch((e) => console.error("dispatch error:", e));
  }

  return c.json(updated);
});

app.get("/tasks/:id/posts", async (c) => {
  const id = parseInt(c.req.param("id"));
  const taskIdStr = String(id);
  const posts = await sql`
    SELECT * FROM posts WHERE context = ${taskIdStr} ORDER BY created_at DESC
  `;
  return c.json(posts);
});

const TASK_DISPATCH_URL = process.env.TASK_DISPATCH_URL;

async function dispatchTask(task: Record<string, unknown>) {
  if (!TASK_DISPATCH_URL) return;

  let url = TASK_DISPATCH_URL;
  if (task.category === "adjudicate") {
    url = TASK_DISPATCH_URL.replace(/\/task$/, "/adjudicate");
  }

  const body: Record<string, unknown> = task.category === "adjudicate"
    ? { context: task.description, source_workflow: task.workflow_name ?? "", source_namespace: "claude-code" }
    : { id: task.id, title: task.title, description: task.description,
        category: task.category, priority: task.priority, tags: task.tags };

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function notifyDiscord(task: Record<string, unknown>) {
  if (!DISCORD_WEBHOOK_URL) return;

  const payload = {
    embeds: [{
      title: `🔔 承認待ちタスク: ${task.title}`,
      description: `**カテゴリ**: ${task.category}\n**優先度**: ${task.priority}\n**判断理由**: ${task.decision_reason}\n\n${task.description}`,
      color: task.priority === "critical" ? 16711680 : task.priority === "high" ? 16744448 : 3447003,
      timestamp: new Date().toISOString(),
      footer: { text: `Task #${task.id}` },
    }],
  };

  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export { app };
