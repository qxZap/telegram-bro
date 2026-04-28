import { resolve } from "path";

/**
 * Derive the agent's identifier from its working directory.
 *
 * Format: drive letter (lowercased) + every path segment, joined with `-`.
 *   Windows  `E:\eve\eve`              → `e-eve-eve`
 *   Windows  `D:\Repos\claude-skill`   → `d-repos-claude-skill`
 *   Unix     `/home/me/proj`           → `home-me-proj`
 *
 * Override at any time by exporting `TELEGRAM_AGENT_ID` — useful if the
 * cwd path is awkwardly long, or if multiple terminals share a cwd but
 * need distinct identities.
 */
export function deriveAgentId(cwd: string = process.cwd()): string {
  const override = process.env.TELEGRAM_AGENT_ID;
  if (override && override.trim()) return override.trim().toLowerCase();

  const abs = resolve(cwd);
  return abs
    .replace(/[\\\/:]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
}
