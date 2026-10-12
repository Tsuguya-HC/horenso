import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers.js";

const { sql, reset, request } = await loadApp();

before(reset);
beforeEach(reset);
after(() => sql.end());

test("GET /health", async () => {
  const res = await request("GET", "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /posts stores a post and returns it", async () => {
  const res = await request("POST", "/posts", {
    type: "report", source: "test", context: "ctx", body: "hello", tags: ["a", "b"],
  });
  assert.equal(res.status, 201);
  const post = await res.json();
  assert.equal(post.id, 1);
  assert.equal(post.type, "report");
  assert.deepEqual(post.tags, ["a", "b"]);

  const got = await request("GET", "/posts/1");
  assert.equal(got.status, 200);
  assert.equal((await got.json()).body, "hello");
});

test("POST /posts rejects missing fields and unknown types", async () => {
  const missing = await request("POST", "/posts", { type: "report", body: "x" });
  assert.equal(missing.status, 400);
  const badType = await request("POST", "/posts", { type: "rumour", source: "s", body: "x" });
  assert.equal(badType.status, 400);
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM posts`;
  assert.equal(count, 0);
});

test("malformed JSON body is a 400, not a 500", async () => {
  const res = await request("POST", "/posts", "{not json");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid JSON body" });
});

test("GET /posts/:id is 404 for a missing post", async () => {
  const res = await request("GET", "/posts/999");
  assert.equal(res.status, 404);
});

test("GET /posts filters by tag, source and before, newest first", async () => {
  await sql`
    INSERT INTO posts (type, source, body, tags, created_at) VALUES
      ('report', 'a', 'old-a',  ARRAY['x'], NOW() - interval '2 hours'),
      ('report', 'b', 'old-b',  ARRAY['x'], NOW() - interval '1 hour'),
      ('update', 'a', 'new-a',  ARRAY['y'], NOW())
  `;
  const bodies = async (q: string) =>
    ((await (await request("GET", `/posts${q}`)).json()) as { body: string }[]).map((p) => p.body);

  assert.deepEqual(await bodies(""), ["new-a", "old-b", "old-a"]);
  assert.deepEqual(await bodies("?tag=x"), ["old-b", "old-a"]);
  assert.deepEqual(await bodies("?source=a"), ["new-a", "old-a"]);
  assert.deepEqual(await bodies("?tag=x&source=a"), ["old-a"]);
  const cutoff = encodeURIComponent(new Date(Date.now() - 30 * 60_000).toISOString());
  assert.deepEqual(await bodies(`?before=${cutoff}`), ["old-b", "old-a"]);
  assert.deepEqual(await bodies(`?before=${cutoff}&source=b`), ["old-b"]);
  assert.deepEqual(await bodies(`?tag=x&before=${cutoff}&source=a`), ["old-a"]);
  assert.deepEqual(await bodies("?limit=1"), ["new-a"]);
});

test("GET /posts caps limit at 100", async () => {
  await sql`
    INSERT INTO posts (type, source, body)
    SELECT 'report', 's', 'b' || g FROM generate_series(1, 105) g
  `;
  const res = await request("GET", "/posts?limit=500");
  assert.equal(((await res.json()) as unknown[]).length, 100);
});
