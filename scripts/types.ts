import { homedir } from "os";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { Id } from "../convex/_generated/dataModel.js";

/**
 * User-level configuration stored in the OS home directory so the skill
 * can be invoked from any working directory on the machine.
 */
export interface Config {
  botToken: string;
  userId: string;
  deployKey: string;
  /**
   * Full Convex deployment URL including region segment, e.g.
   * "https://<deployment>.<region>.convex.cloud". The region cannot
   * be derived from the deploy key alone — setup captures it from
   * `npx convex function-spec` and persists it here.
   */
  convexUrl?: string;
  setupDate: string;
}

/**
 * Scheduled message record from database
 */
export interface ScheduledMessage {
  _id: Id<"scheduled_messages">;
  title: string;
  message_text?: string;
  storage_id?: Id<"_storage">;
  file_name?: string;
  scheduled_time: number;
  recurring?: string;
  status: string;
  created_at: number;
  last_sent_at?: number;
  error_message?: string;
}

/**
 * Message history record from database
 */
export interface MessageHistory {
  _id: Id<"message_history">;
  title: string;
  message_text?: string;
  sent_at: number;
  status: string;
  direction?: string; // "outbound" | "inbound"
  error_message?: string;
  scheduled_message_id?: Id<"scheduled_messages">;
  telegram_message_id?: number;
}

/**
 * Telegram bot info from getMe API
 */
export interface BotInfo {
  username: string;
}

/**
 * Parsed time result from natural language processing
 */
export interface ParsedTime {
  scheduledTime: number;
  recurring?: string;
}

/**
 * Skill root — the directory containing package.json, convex/, scripts/, etc.
 * Resolved from this file's location so it's correct no matter where the
 * skill is installed or which cwd invokes it.
 */
export const SKILL_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  ".."
);

/**
 * Per-user config directory. Lives in the OS home so setup is one-time
 * and the config survives skill reinstalls / upgrades.
 */
export const CONFIG_DIR = resolve(homedir(), ".claude-telegram");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

/**
 * Claude Code's user-level skills directory. Dropping SKILL.md here makes the
 * telegram skill available to every Claude Code instance on the machine without
 * per-project copying.
 */
export const CLAUDE_SKILL_DIR = resolve(homedir(), ".claude", "skills", "telegram");

/**
 * Resolve the Convex deployment URL for a loaded config.
 * Prefers the explicit URL captured at setup (includes region), falls back
 * to deriving from the deploy key (region-less — only works for legacy
 * deployments without a region segment).
 */
export function getConvexUrl(config: Config): string {
  if (config.convexUrl) return config.convexUrl;
  const parts = config.deployKey.split("|")[0].split(":");
  if (parts.length < 2) {
    throw new Error("Invalid deploy key format");
  }
  return `https://${parts[1]}.convex.cloud`;
}
