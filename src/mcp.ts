import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
