import { spawn } from "node:child_process";

interface Task {
  id: number;
  title: string;
  description: string;
  category: string;
  priority: string;
  tags: string[];
}

interface Decision {
  action: "auto" | "ask";
  reason: string;
}

const JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    action: { type: "string", enum: ["auto", "ask"] },
    reason: { type: "string", description: "判断理由（日本語、1-2文）" },
  },
  required: ["action", "reason"],
});

const POLICY_GUIDELINES = `あなたはタスク判断エージェントです。以下のタスクについて、自動実行 (auto) するか、ユーザの承認を求める (ask) か判定してください。

## ポリシーガイドライン

- 副作用なし（調査・観測・ログ確認） → auto
- 可逆で影響範囲が小さい（Pod restart, PR 作成） → auto
- Git マニフェスト変更は PR 作成まで auto、マージは ask
- ノード操作（drain, cordon）→ ask
- RBAC・権限変更 → ask
- infra（Talos）変更 → ask
- cloudflare（DNS, WAF, Tunnel）変更 → ask
- 判断に迷ったら ask（false positive のほうが false negative より安全）`;

export async function judge(task: Task): Promise<Decision> {
  const prompt = `${POLICY_GUIDELINES}

## タスク情報

- タイトル: ${task.title}
- 説明: ${task.description}
- カテゴリ: ${task.category}
- 優先度: ${task.priority}
- タグ: ${task.tags.join(", ") || "なし"}`;

  try {
    const result = await runClaude(prompt);
    const json = JSON.parse(result);
    const parsed = json.structured_output ?? json.result ?? json;
    if (parsed.action !== "auto" && parsed.action !== "ask") {
      return { action: "ask", reason: "判断エージェントの出力が不正のため ask にフォールバック" };
    }
    return { action: parsed.action, reason: parsed.reason };
  } catch (e) {
    return { action: "ask", reason: `判断エージェントエラー: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p",
      "--output-format", "json",
      "--json-schema", JSON_SCHEMA,
      "--model", "haiku",
      prompt,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}
