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

## 原則

auto を積極的に選べ。ask は「本当に危険な場合」だけ。ユーザは細かい確認を求めていない。

## auto にすべきケース

- 副作用なし（調査・観測・ログ確認・裁定依頼）
- 可逆で影響範囲が小さい（Pod restart, PR 作成）
- 安全側への変更（リソース limit 引き上げ、メモリ/CPU 追加、レプリカ増加）
- 既存の問題を修正する変更（OOMKill 対策、エラー修正、設定ミス修正）
- Git マニフェスト変更で、変更内容が明確かつ安全なもの
- CNP の egress/ingress 追加（通信を許可する方向）
- Helm values の微修正（リソース、レプリカ数、ログレベル等）

## ask にすべきケース（本当に危険なもの限定）

- ノード操作（drain, cordon, upgrade）
- RBAC・権限変更（新しい権限の付与）
- infra（Talos）変更
- cloudflare（DNS, WAF, Tunnel）変更
- データ削除・DB マイグレーション
- セキュリティ設定の緩和（PSA レベル下げ、CNP ルール削除）
- 複数サービスに跨がるアーキテクチャ変更

## 迷ったら

変更が「元に戻せるか」「安全側か」で判断。可逆 + 安全側 = auto。`;

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
