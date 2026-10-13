import { serve } from "@hono/node-server";
import { app } from "./routes.js";
import { migrate, sql } from "./db.js";

const port = parseInt(process.env.PORT ?? "3000");

await migrate();
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`horenso listening on :${info.port}`);
});

// コンテナでは node が PID 1 で、PID 1 は既定の動作のシグナルを受け取らない。
// 自分でハンドラを持たないと SIGTERM が無視され、Pod の停止が猶予切れの
// SIGKILL（処理中のリクエストごと）になる。受け付けを止め、処理中の
// リクエストを終えてから DB 接続を閉じて抜ける。
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await sql.end({ timeout: 5 });
      process.exit(0);
    });
  });
}
