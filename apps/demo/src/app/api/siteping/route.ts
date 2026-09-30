import { createSitepingHandler } from "@siteping/adapter-prisma";
import { memoryStore } from "@/lib/memory-store";
import { sitepingAuthFromEnv } from "@/lib/siteping-auth";

// Webhook notifications — uncomment to ping Slack/Discord on each new feedback.
// (Self-hosted demos: drop your incoming webhook URL into the env and you're done.)
//
// const SLACK_WEBHOOK = process.env.SITEPING_SLACK_WEBHOOK;
// const DISCORD_WEBHOOK = process.env.SITEPING_DISCORD_WEBHOOK;

export const { GET, POST, PATCH, DELETE, OPTIONS } = createSitepingHandler({
  store: memoryStore,
  // With no OIDC variables, this demo intentionally keeps destructive requests public.
  // When OIDC is configured, reads default to admin-only and owner deletes are disabled.
  ...sitepingAuthFromEnv(),
  // webhooks: [
  //   ...(SLACK_WEBHOOK ? [{ url: SLACK_WEBHOOK, type: "slack" as const }] : []),
  //   ...(DISCORD_WEBHOOK ? [{ url: DISCORD_WEBHOOK, type: "discord" as const }] : []),
  // ],
});
