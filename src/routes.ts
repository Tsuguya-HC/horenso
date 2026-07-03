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
          ${[appName, "argocd", event]},
          'approved',
          'auto',
          'ArgoCD failed/degraded イベントによる自動タスク作成'
        )
        RETURNING *
      `;
    }
  }

  return c.json({ post, task }, 201);
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
