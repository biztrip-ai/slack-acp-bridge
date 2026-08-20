/**
 * Bridge commands. Slack swallows unregistered slash commands, so the same
 * commands are also accepted as `!name args` in a thread/DM message (works
 * even when the app lacks the `commands` scope).
 */
export const COMMANDS = ["help", "clear", "stop", "agent", "mode"] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface ParsedCommand {
  name: CommandName;
  args: string;
}

export function parseBangCommand(text: string): ParsedCommand | undefined {
  const m = /^!([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  if (!(COMMANDS as readonly string[]).includes(name)) return undefined;
  return { name: name as CommandName, args: (m[2] ?? "").trim() };
}

export const HELP_TEXT = [
  "*Commands* — as `/command` (if installed) or `!command` in a message:",
  "• `!clear` — reset this thread's session",
  "• `!stop` — cancel the running turn (and anything queued)",
  "• `!agent [name]` — show or switch the agent for this thread (resets the session)",
  "• `!mode [id]` — show or set the permission mode (e.g. `default`, `acceptEdits`, `plan`, `bypassPermissions`)",
  "• `!help` — this message",
].join("\n");
