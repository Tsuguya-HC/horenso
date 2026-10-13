import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

// コンテナでは node が PID 1 になる。PID 1 は既定の動作のシグナルをカーネルが
// 落とすので、ハンドラが無いと SIGTERM を無視し、Pod の停止は猶予切れの
// SIGKILL 待ちになる。ここでは「SIGTERM を自分で受けて正常終了する」ことを見る
// （PID 1 でなくても、ハンドラが無ければシグナルで殺されて code は null になる）。
test("the server shuts down cleanly on SIGTERM", async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, "TEST_DATABASE_URL is not set");

  const proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, DATABASE_URL: url, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  const deadline = Date.now() + 15_000;
  while (!out.includes("listening")) {
    if (Date.now() > deadline || proc.exitCode !== null) {
      proc.kill("SIGKILL");
      assert.fail(`server did not start: ${out}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const exited = once(proc, "exit");
  proc.kill("SIGTERM");
  const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  const [code, signal] = await exited;
  clearTimeout(timer);
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
});
