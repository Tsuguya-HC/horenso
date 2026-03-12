import { Hono } from "hono";
import { sql } from "./db.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.post("/posts", async (c) => {
  const { type, source, context, body, tags } = await c.req.json();

  if (!type || !source || !body) {
    return c.json({ error: "type, source, body are required" }, 400);
  }
  if (!["report", "update", "question"].includes(type)) {
    return c.json({ error: "type must be report, update, or question" }, 400);
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

export { app };
