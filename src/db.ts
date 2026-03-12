import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://horenso:horenso@localhost:5432/horenso", {
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
});

export async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('report', 'update', 'question')),
      source TEXT NOT NULL,
      context TEXT,
      body TEXT NOT NULL,
      tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_tags ON posts USING GIN (tags)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts (created_at DESC)`;
}

export { sql };
