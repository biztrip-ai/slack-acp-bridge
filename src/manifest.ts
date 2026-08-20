/**
 * Slack app manifest for the bridge. `slack-acp-bridge manifest` prints it so
 * users can create the app at https://api.slack.com/apps → "From a manifest".
 */
export interface ManifestOptions {
  name?: string;
  description?: string;
}

export const BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "commands",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "im:read",
  "im:write",
  "users:read",
  "files:read",
  "files:write",
] as const;

export const BOT_EVENTS = ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"] as const;

export const SLASH_COMMANDS = [
  { command: "/clear", description: "Reset this thread's agent session" },
  { command: "/stop", description: "Cancel the running turn" },
  { command: "/agent", description: "Show or switch the agent for this thread", usage_hint: "[name]" },
  { command: "/mode", description: "Show or set the permission mode", usage_hint: "[id]" },
  { command: "/help", description: "List bridge commands" },
] as const;

export function buildManifest(opts: ManifestOptions = {}): Record<string, unknown> {
  const name = opts.name ?? "slack-acp-bridge";
  return {
    display_information: {
      name,
      description: opts.description ?? "Relay Slack threads to an ACP coding agent.",
      background_color: "#1f2937",
    },
    features: {
      bot_user: { display_name: name, always_online: false },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      slash_commands: SLASH_COMMANDS.map((c) => ({ ...c, should_escape: false })),
    },
    oauth_config: { scopes: { bot: [...BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export const SETUP_STEPS = `Slack app setup
===============
1. Go to https://api.slack.com/apps → "Create New App" → "From a manifest".
2. Pick your workspace, paste the JSON above (JSON tab), review, "Create".
3. Basic Information → "App-Level Tokens" → "Generate Token and Scopes":
   add scope connections:write → Generate. Copy the xapp-… token → SLACK_APP_TOKEN.
4. "Install App" → "Install to Workspace" → Allow. Copy the xoxb-… Bot User
   OAuth Token → SLACK_BOT_TOKEN.
5. Invite the bot to the channels you want it in: /invite @<bot name>.

Changing scopes or events later requires "Reinstall to Workspace".
`;
