#!/usr/bin/env node
/**
 * Per-session Slack MCP server. Spawned by the agent (stdio transport) with
 * SLACK_ACP_BRIDGE_SOCK and SLACK_ACP_BRIDGE_SESSION in its environment; every
 * tool call is forwarded to the bridge over the unix socket, which performs the
 * Slack API call for this session's thread. No Slack credentials live here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callBridge } from "./bridge-socket.js";

const sock = process.env.SLACK_ACP_BRIDGE_SOCK;
const session = process.env.SLACK_ACP_BRIDGE_SESSION;
if (!sock || !session) {
  process.stderr.write("slack-acp-bridge mcp: SLACK_ACP_BRIDGE_SOCK and SLACK_ACP_BRIDGE_SESSION are required\n");
  process.exit(2);
}

const server = new McpServer({ name: "slack", version: "0.1.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

server.registerTool(
  "slack_upload_file",
  {
    title: "Upload a file to the Slack thread",
    description:
      "Upload a local file (image, screenshot, PDF, log, …) into the Slack thread this conversation is happening in. " +
      "Use this to show the user rich media instead of describing it. Paths are resolved against the session working directory.",
    inputSchema: {
      path: z.string().describe("Absolute or cwd-relative path of the file to upload"),
      title: z.string().optional().describe("Optional title shown in Slack"),
      comment: z.string().optional().describe("Optional message posted with the file"),
    },
  },
  async ({ path, title, comment }) => {
    try {
      const r = (await callBridge(sock, session, "upload_file", { path, title, comment })) as { ok: boolean; error?: string };
      return r.ok ? text(`Uploaded ${path} to the thread.`) : { ...text(`Upload failed: ${r.error}`), isError: true };
    } catch (e) {
      return { ...text(`Upload failed: ${e instanceof Error ? e.message : String(e)}`), isError: true };
    }
  },
);

server.registerTool(
  "slack_post_message",
  {
    title: "Post a message to the Slack thread",
    description:
      "Post a standalone message into the current Slack thread immediately (e.g. a progress update during a long task). " +
      "Your normal reply is streamed automatically — only use this for out-of-band notes. Slack mrkdwn formatting.",
    inputSchema: { text: z.string().describe("Message text (Slack mrkdwn)") },
  },
  async ({ text: body }) => {
    try {
      await callBridge(sock, session, "post_message", { text: body });
      return text("Posted.");
    } catch (e) {
      return { ...text(`Post failed: ${e instanceof Error ? e.message : String(e)}`), isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
