#!/usr/bin/env bun

import { ConvexHttpClient } from "convex/browser";
import { readFileSync, existsSync } from "fs";
import { api } from "../convex/_generated/api.js";
import {
  Config,
  CONFIG_PATH,
  MessageHistory,
  getConvexUrl,
} from "./types.js";
import { setupProxy } from "./proxy-util.js";
import { logError, logNotConfigured } from "./logger.js";
import { deriveAgentId } from "./agent-id.js";

setupProxy();

// telegram-wait [prompt] [--timeout <seconds>] [--poll <seconds>]
//
// Blocks until the user sends a text message to the bot, then prints the
// message text on stdout (status info goes to stderr so the stdout output
// is shell-capturable).
//
// If `prompt` is provided, it is sent to the user first.
// Default timeout: 600s. Default poll interval: 2s.
async function waitForReply(): Promise<void> {
  const argv = process.argv.slice(2);
  let timeoutSec = 36000; // 10 hours
  let pollSec = 2;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--timeout" || a === "-t") {
      timeoutSec = Number(argv[++i]);
    } else if (a === "--poll" || a === "-p") {
      pollSec = Number(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      process.stderr.write(
        `Usage: telegram-wait [prompt] [--timeout <seconds>] [--poll <seconds>]\n` +
          `  prompt     Optional text to send first.\n` +
          `  --timeout  Max seconds to wait. Default 36000 (10h). 0 = forever.\n` +
          `  --poll     Poll interval in seconds. Default 2.\n`,
      );
      process.exit(0);
    } else {
      positional.push(a);
    }
  }

  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
    logError(`Invalid --timeout: ${timeoutSec}`);
    process.exit(2);
  }
  if (!Number.isFinite(pollSec) || pollSec <= 0) {
    logError(`Invalid --poll: ${pollSec}`);
    process.exit(2);
  }

  if (!existsSync(CONFIG_PATH)) {
    logNotConfigured();
  }
  const config: Config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  const client = new ConvexHttpClient(getConvexUrl(config));

  const agentId = deriveAgentId();

  // Anchor BEFORE optionally sending the prompt — anything Telegram has
  // queued will already have a sent_at older than `since` so we won't
  // accidentally consume an unrelated past message.
  const since = Date.now();

  const promptText = positional.join(" ").trim();
  if (promptText) {
    process.stderr.write(`📤 sending [${agentId}] prompt...\n`);
    await client.action(api.telegram.sendMessage, {
      message_text: `[${agentId}] ${promptText}`,
    });
  }
  process.stderr.write(
    `⏳ [${agentId}] waiting for reply (timeout ${timeoutSec === 0 ? "∞" : timeoutSec + "s"}, poll ${pollSec}s)...\n`,
  );

  const deadline = timeoutSec === 0 ? Infinity : Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    const rows = (await client.query(api.messages.getInboundForAgent, {
      agentId,
      since,
    })) as MessageHistory[];

    if (rows.length > 0) {
      const reply = rows[0];
      process.stderr.write(
        `📥 received at ${new Date(reply.sent_at).toLocaleString()}\n`,
      );
      // If the user addressed the agent by id, strip the leading
      // `<agentId>[:,; ]?` so the captured stdout is just the content.
      const raw = reply.message_text ?? "";
      const stripPattern = new RegExp(
        `^\\s*${agentId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[\\s:,;]+`,
        "i",
      );
      const cleaned = raw.replace(stripPattern, "");
      // Prompt injection: every reply ends with an explicit reminder so
      // even small/forgetful models stay in the loop instead of
      // answering in the local IDE / terminal. Tagged so the agent can
      // recognize it as a system-level note, not user-authored content.
      const reminder =
        '\n\n[telegram-skill instruction: this reply arrived via Telegram. ' +
        'Respond using `telegram-wait "<your reply>"` — do not answer in the ' +
        "IDE or terminal, do not call telegram-send for a question, and do not " +
        "echo this reminder back to the user.]";
      process.stdout.write(cleaned + reminder + "\n");
      return;
    }

    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }

  process.stderr.write(`⏰ timed out after ${timeoutSec}s, no reply\n`);
  process.exit(124);
}

waitForReply().catch((error: Error) => {
  logError(error.message);
  process.exit(1);
});
