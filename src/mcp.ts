import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { judge } from "./judge.js";

const API_URL = process.env.HORENSO_API_URL ?? "http://localhost:3000";

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return res.json();
}

const server = new McpServer({
  name: "horenso",
  version: "0.1.0",
});

server.tool(
  "post",
  "掲示板に投稿する（報告・連絡・相談）",
  {
    type: z.enum(["report", "update", "question"]).describe("report=報告, update=連絡, question=相談"),
    body: z.string().describe("投稿内容"),
    source: z.string().optional().describe("投稿元 (例: claude-code, argo-wf, alert-monitor)"),
    context: z.string().optional().describe("コンテキスト (例: タスク名、WF名)"),
    tags: z.array(z.string()).optional().describe("タグ (例: ['あとよろ', 'critical'])"),
  },
  async ({ type, body, source, context, tags }) => {
    const result = await api("/posts", {
      method: "POST",
      body: JSON.stringify({
        type,
        body,
        source: source ?? "claude-code",
        context,
        tags,
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Tasks ---

server.tool(
  "create_task",
  "タスクを作成する（判断エージェントが auto/ask を判定）",
  {
    title: z.string().describe("タスクのタイトル"),
    description: z.string().describe("タスクの詳細"),
    category: z.enum(["investigate", "modify_manifest", "modify_infra", "modify_cloudflare", "operate", "observe"])
      .describe("investigate=調査, modify_manifest=K8sマニフェスト変更, modify_infra=Talos変更, modify_cloudflare=CF変更, operate=運用操作, observe=観測"),
    priority: z.enum(["low", "normal", "high", "critical"]).optional().describe("優先度 (デフォルト: normal)"),
    tags: z.array(z.string()).optional().describe("タグ"),
    parent_task_id: z.number().optional().describe("親タスクID（サブタスクの場合）"),
  },
  async ({ title, description, category, priority, tags, parent_task_id }) => {
    const decision = await judge({
      id: 0,
      title,
      description,
      category,
      priority: priority ?? "normal",
      tags: tags ?? [],
    });

    const status = decision.action === "auto" ? "approved" : "waiting_approval";

    const result = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title, description, category, priority, tags, parent_task_id,
        status, decision: decision.action, decision_reason: decision.reason,
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "list_tasks",
  "タスク一覧を取得する",
  {
    status: z.string().optional().describe("ステータスでフィルタ (pending, approved, running, waiting_approval, completed, failed, cancelled)"),
    category: z.string().optional().describe("カテゴリでフィルタ"),
    tag: z.string().optional().describe("タグでフィルタ"),
    limit: z.number().optional().describe("取得件数 (デフォルト20, 最大100)"),
  },
  async ({ status, category, tag, limit }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (category) params.set("category", category);
    if (tag) params.set("tag", tag);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    const result = await api(`/tasks${query ? `?${query}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "approve_task",
  "タスクを承認する",
  { id: z.number().describe("タスクID") },
  async ({ id }) => {
    const result = await api(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "approved" }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "reject_task",
  "タスクを拒否する",
  {
    id: z.number().describe("タスクID"),
    reason: z.string().describe("拒否理由"),
  },
  async ({ id, reason }) => {
    const result = await api(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled", result: `拒否: ${reason}` }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "complete_task",
  "タスクを完了にする",
  {
    id: z.number().describe("タスクID"),
    result: z.string().describe("タスクの結果"),
  },
  async ({ id, result: taskResult }) => {
    const res = await api(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed", result: taskResult }),
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

// --- Posts ---

server.tool(
  "read",
  "掲示板の投稿を読む",
  {
    tag: z.string().optional().describe("タグでフィルタ"),
    source: z.string().optional().describe("投稿元でフィルタ"),
    limit: z.number().optional().describe("取得件数 (デフォルト20, 最大100)"),
  },
  async ({ tag, source, limit }) => {
    const params = new URLSearchParams();
    if (tag) params.set("tag", tag);
    if (source) params.set("source", source);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    const result = await api(`/posts${query ? `?${query}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
