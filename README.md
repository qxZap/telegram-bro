# telegram-bro

Two-way Telegram channel for AI agents. Six globally-installed CLI commands let any AI assistant (Claude Code, opencode, gemini-cli, custom MCP clients, anything that can shell out) send messages to your Telegram and **block-and-wait** for replies. Webhook-based inbound capture, agent-aware routing by working-directory, and a Convex backend that fires scheduled reminders 24/7.

## What you get

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `telegram-send`    | Send a message (or message + file) right now.                        |
| `telegram-wait`    | Send a prompt **and** block until the user replies. Reply on stdout. |
| `telegram-schedule`| Fire a future / recurring reminder from Convex Cloud.                |
| `telegram-list`    | List scheduled messages.                                             |
| `telegram-cancel`  | Cancel a scheduled message.                                          |
| `telegram-history` | Show recent messages, both directions.                               |
| `telegram-setup`   | One-time install: deploy backend, register webhook, write config.    |

All commands work from **any** working directory. Each agent self-identifies by its cwd path (e.g. `D:\Repos\my-bot` → `[d-repos-my-bot]`), so multiple agents on one machine can talk to the same Telegram chat without crossing wires.

## Quick install

```bash
git clone https://github.com/qxZap/telegram-bro.git
cd telegram-bro
bun install
bun link
telegram-setup "<bot_token>" "<user_id>" "<convex_deploy_key>"
```

Then open the bot in Telegram and press **Start** once. (Telegram refuses outbound messages to a chat the user has never initiated.)

## Get the three credentials

1. **Bot token** — message [@BotFather](https://t.me/BotFather), `/newbot`, copy the token.
2. **User ID** — message [@userinfobot](https://t.me/userinfobot), copy the numeric ID.
3. **Convex deploy key** — [dashboard.convex.dev](https://dashboard.convex.dev) → new project → Settings → Deploy Keys → create one (dev or prod is fine).

`telegram-setup` does the rest: deploys the Convex functions, captures the deployment URL (region-aware), sets `TELEGRAM_BOT_TOKEN` / `TELEGRAM_USER_ID` as Convex env vars, and registers the inbound webhook.

## How `telegram-wait` works

```bash
$ telegram-wait "ready to push to prod?"
📤 sending [d-repos-my-bot] prompt...
⏳ [d-repos-my-bot] waiting for reply (timeout 36000s, poll 2s)...
📥 received at 4/29/2026, 12:34:56 AM
yes go
```

The reply lands on **stdout** so it's shell-capturable. Status info goes to stderr.

The user can address an agent two ways: prefix (`d-repos-my-bot: yes go`) or by tap-and-Reply on the agent's message in the Telegram client. Replies that match neither route stay in `telegram-history` for inspection but don't unblock any waiter.

Default timeout is 10 hours. Override per call with `--timeout 120` (seconds), or `--timeout 0` for unlimited.

Every reply is post-fixed with a system instruction reminding the agent to keep the conversation in Telegram — small models tend to drop the loop otherwise.

## Long messages

For anything over a few sentences, especially with URLs/quotes/parens, **pipe via stdin** instead of cramming into a CLI argument:

```bash
echo "long body here" | telegram-send
telegram-send < file.txt
telegram-send -                # explicit stdin marker
```

Messages over 4096 chars (Telegram's hard limit) auto-split at sentence/word boundaries with `(1/N)` continuation markers, and every chunk carries the agent prefix so reply-by-tap works on whichever message the user picks.

Literal `\n`, `\t`, and `\r\n` in the input get decoded to real characters automatically — agents that emit JSON-style escape sequences just work.

## Skill files

- [`SKILL.md`](SKILL.md) — drop into a Claude Code skill folder (`~/.claude/skills/telegram/`) or any agent's skill directory. Lists commands and rules. No code logic — pure instructions. `telegram-setup` installs it there automatically; `telegram-install-skill` (re)installs it standalone without redeploying.
- [`prompt.txt`](prompt.txt) — same content, system-prompt format, for non-Claude AIs (opencode/qwen/etc). Drilled with explicit anti-patterns for small models that confuse skill-name with tool-name.

## Conversational + sticky modes

Trigger a chat loop with **"let's chat on Telegram"**, **"continue on Telegram"**, etc. Trigger sticky mode with **"telegram mode on"** — every reply for the rest of the session goes through Telegram until the user says **"telegram mode off"** / **"back to terminal"**.

Full flow rules in [`SKILL.md`](SKILL.md).

## Architecture

- **Convex Cloud** — schema, queries, mutations, scheduler, and HTTP webhook handler. Free tier covers personal use.
- **Outbound** — `telegram-send`/`telegram-wait` POST to Convex, which calls Telegram Bot API and stores the message in `message_history` (with the Telegram message_id for reply-matching).
- **Scheduler** — 1-minute cron polls `scheduled_messages` for due rows and sends them.
- **Inbound** — Telegram webhook → Convex HTTP action at `*.convex.site/telegram-webhook` → recorded as inbound history rows with `reply_to_telegram_message_id` when the user used Reply.
- **Routing** — `telegram-wait` queries `getInboundForAgent(agentId, since)` which filters to messages addressed to **this** agent only (by prefix or by reply-to chain).

## Files at a glance

```
telegram-bro/
  scripts/
    send_message.ts      # telegram-send (stdin, auto-split, escape decode)
    wait_message.ts      # telegram-wait (per-agent filter, reminder injection)
    schedule_message.ts  # telegram-schedule
    list_scheduled.ts    # telegram-list
    cancel_message.ts    # telegram-cancel
    view_history.ts      # telegram-history
    setup.ts             # telegram-setup (one-time install)
    agent-id.ts          # cwd → agent id derivation
    types.ts             # shared types + config-path resolution
    proxy-util.ts        # HTTP_PROXY/HTTPS_PROXY honoring
    logger.ts            # shared CLI logger
  convex/
    schema.ts            # scheduled_messages, message_history tables
    messages.ts          # mutations + queries (incl. getInboundForAgent)
    telegram.ts          # send actions + cron processor
    http.ts              # /telegram-webhook handler
    crons.ts             # 1-minute scheduler
  SKILL.md               # for Claude-style skill consumers
  prompt.txt             # for non-Claude system prompts
  references/            # deeper notes on architecture, error handling, setup
  package.json           # bin entries for telegram-* commands
```

## Configuration files

- `~/.claude-telegram/config.json` — bot token, user id, deploy key, deployment URL. Survives reinstalls.
- `<repo>/.env` — local convenience copy of the deploy key (gitignored).
- `<repo>/.env.local` — used by `npx convex` CLI commands during setup (gitignored).

## Troubleshooting

| Symptom                                          | Fix                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `telegram-send` succeeds but nothing arrives     | Open the bot in Telegram and press Start once.                                                 |
| `telegram-wait` times out though you replied     | Use the exact agent-id prefix, or tap-and-Reply on the agent's message.                        |
| Two agents share an id and one blocks forever    | Set `TELEGRAM_AGENT_ID=<unique>` in one of them.                                               |
| Empty 404 from Convex                            | `convexUrl` in `~/.claude-telegram/config.json` is missing the region segment. Re-run setup.   |
| Small model invents a phantom `telegram` tool    | The agent confused skill-name with tool-name. `prompt.txt` and `SKILL.md` already drill this — make sure the agent loaded them. |
| Literal `\n` shows up in the message             | Already fixed — escape decoding is automatic.                                                  |

For deeper context, see [`references/architecture.md`](references/architecture.md), [`references/error_handling.md`](references/error_handling.md), [`references/initial_setup.md`](references/initial_setup.md).

## Status

Personal-use, single-user. Built on top of an upstream sandbox skill but rebuilt from scratch for local-machine multi-agent use: stdin/auto-split sending, agent-aware inbound routing, conversational + sticky modes, prompt-injected reminders, escape decoding.
