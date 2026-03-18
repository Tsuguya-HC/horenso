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

  // Add 'event' type to posts CHECK constraint
  await sql`DO $$ BEGIN
    ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_type_check;
    ALTER TABLE posts ADD CONSTRAINT posts_type_check
      CHECK (type IN ('report', 'update', 'question', 'event'));
  END $$`;

  await sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','running','waiting_approval',
                          'completed','failed','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low','normal','high','critical')),
      category TEXT NOT NULL
        CHECK (category IN ('investigate','modify_manifest','modify_infra',
                            'modify_cloudflare','operate','observe','adjudicate')),
      source TEXT NOT NULL DEFAULT 'claude-code',
      parent_task_id INTEGER REFERENCES tasks(id),
      workflow_name TEXT,
      decision TEXT CHECK (decision IN ('auto', 'ask')),
      decision_reason TEXT,
      result TEXT,
      tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks USING GIN (tags)`;

  // Add 'adjudicate' category to tasks CHECK constraint
  await sql`DO $$ BEGIN
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_category_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_category_check
      CHECK (category IN ('investigate','modify_manifest','modify_infra',
                          'modify_cloudflare','operate','observe','adjudicate'));
  END $$`;
}

export { sql };
