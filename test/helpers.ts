// テストの共通部品。
//
// 本物の Postgres に対して走らせる。テストは毎回テーブルを TRUNCATE するので、
// 接続先は DATABASE_URL ではなく専用の TEST_DATABASE_URL で受け取り、未設定なら
// 何もせずに落とす — 手元の DATABASE_URL が本番を向いていても消さないため。
//
// routes.ts / db.ts は import 時に環境変数を読むので、環境を整えてから
// 動的 import する。node --test はファイルごとに別プロセスで動くため、
// この設定はファイル単位で閉じる。
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  path: string;
  body: Record<string, unknown>;
}

// TASK_DISPATCH_URL / DISCORD_WEBHOOK_URL の受け口。届いたリクエストを記録し、
// status で返すステータスコードを切り替えられる。
export async function startReceiver() {
  const received: Received[] = [];
  const state = { status: 200 };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: data ? JSON.parse(data) : {} });
      res.statusCode = state.status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function loadApp(env: Record<string, string> = {}) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set; tests truncate tables and refuse to guess a database");
  }
  process.env.DATABASE_URL = url;
  Object.assign(process.env, env);

  const { app } = await import("../src/routes.js");
  const { sql, migrate } = await import("../src/db.js");
  await migrate();

  const reset = () => sql`TRUNCATE posts, tasks RESTART IDENTITY CASCADE`;
  const request = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });

  return { app, sql, reset, request };
}

// dispatchTask / notifyDiscord は応答を待たずに投げっぱなしなので、
// 受け口に届くまで少し待つ。
export async function waitFor(cond: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
