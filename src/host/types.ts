import type { StopReason, ToolCallUpdate, ToolCall, PermissionOption, ContentBlock } from "@agentclientprotocol/sdk";

/** How to launch an ACP agent process. */
export interface AgentConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Default session mode for this agent (overrides the global permissionMode; e.g. "full-access" for codex-acp). */
  permissionMode?: string;
}

export type PromptBlock = ContentBlock;

/** Normalized per-turn events the Slack layer consumes (the old Python `Chunk`). */
export type TurnEvent =
  | { kind: "turn_start"; turn: number }
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; id: string; title: string; toolName?: string; kind_?: string; input?: unknown }
  | { kind: "tool_update"; id: string; status?: string; title?: string; isError: boolean; summary?: string }
  | { kind: "done"; stopReason: StopReason; usage?: unknown };

export type PermissionRequest = {
  sessionId: string;
  toolCall: ToolCallUpdate | ToolCall;
  options: PermissionOption[];
};

export type PermissionDecision = { optionId: string } | { cancelled: true };
export type PermissionPolicy = (
  req: PermissionRequest,
  signal: AbortSignal,
) => Promise<PermissionDecision> | PermissionDecision;

/** Pick an allow-shaped option without asking anyone. */
export const allowAllPolicy: PermissionPolicy = (req) => {
  const pick =
    req.options.find((o) => o.kind === "allow_once") ??
    req.options.find((o) => o.kind === "allow_always") ??
    req.options[0];
  return pick ? { optionId: pick.optionId } : { cancelled: true };
};

export type ModeState = { currentModeId: string; availableModes: { id: string; name: string }[] };
