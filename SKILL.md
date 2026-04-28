---
name: telegram
description: Two-way Telegram channel for AI agents. Send messages, schedule reminders, and block-and-wait for the user's reply. Each agent identifies itself by its working-directory path, so multiple agents on one machine can talk to the same user without crossing wires.
---

# Telegram Agent Channel

A pair of CLI tools — `telegram-send` and `telegram-wait`, plus four helpers — that let any AI assistant message the user on Telegram and pause until the user answers, all from the terminal.

## Identity

Every command derives an **agent id** from the current working directory:

| cwd                              | agent id                          |
| -------------------------------- | --------------------------------- |
| `E:\eve\eve`                     | `e-eve-eve`                       |
| `D:\Repos\my-bot`                | `d-repos-my-bot`                  |
| `/home/me/proj`                  | `home-me-proj`                    |

Outgoing messages are auto-prefixed `[<agent-id>]`. The `wait` command only returns messages that are addressed to *this* agent. Two terminals in different folders can both `telegram-wait` and never steal each other's replies.

Override the auto-id with `TELEGRAM_AGENT_ID=foo` if the path is awkward.

## How the user replies

Two ways, both work:

1. **By prefix** — `e-eve-eve: yes proceed` (or any of `:` `,` `;` ` ` after the id).
2. **By replying** to the agent's message in the Telegram client (long-press → Reply, or swipe-to-reply on mobile). No prefix needed — the webhook tracks `reply_to_message_id` and matches it back to the sending agent.

If the user starts a fresh message that doesn't match any agent's id and isn't a reply, no agent picks it up. It still lands in `telegram-history` if you ever need to inspect raw inbound traffic.

## Message format rules

- **Plain text only.** No newlines, no Markdown tricks. One thought per message.
- Keep it under ~200 chars. Telegram is a phone notification — long walls of text are hostile.
- One message per logical event. Don't spam the user with a play-by-play.

## Commands

```
telegram-send "<text>" ["<file>"]
telegram-wait ["<prompt>"] [--timeout <sec>] [--poll <sec>]
telegram-schedule "<time>" "<title>" "<text>" ["<file>"]
telegram-list
telegram-cancel <message_id>
telegram-history [limit]
```

All of them work from any directory once the package is installed (`bun link` in the skill repo, see "Install" below).

### `telegram-send`

Send a one-shot message right now.

```bash
telegram-send "deploy finished, all green"
telegram-send "here is the report" /tmp/report.pdf
```

The user sees `[<agent-id>] deploy finished, all green` in their Telegram.

### `telegram-wait`

Block until the user replies, then print the reply on **stdout** (so it can be `$()`-captured). Status info goes to stderr.

```bash
# Just wait for any reply, default 10h timeout
telegram-wait

# Send a question, then wait
telegram-wait "ready to push to prod?"

# Capture the answer
ANSWER=$(telegram-wait "y or n?")
case "$ANSWER" in
  y|Y|yes) echo "going" ;;
  *) echo "aborting" ;;
esac

# Tighter polling for chatty interactions
telegram-wait "anything?" --poll 1 --timeout 120
```

If the user wrote `e-eve-eve: yes`, stdout is `yes` (the prefix is stripped). If they replied to the message in Telegram, stdout is whatever they typed.

Exit codes: `0` reply received · `124` timed out · `1`/`2` errors.

### `telegram-schedule`

Fire a message at a future time, even when this terminal is closed. Convex Cloud runs the scheduler 24/7.

```bash
telegram-schedule "in 10 minutes" "ping" "stand up"
telegram-schedule "tomorrow 9am" "daily" "morning check-in"
telegram-schedule "every 2 hours" "hydrate" "drink water"
```

Recurring strings: `every minute`, `every 5 minutes`, `every 30 minutes`, `every hour`, `every 2 hours`, `every day`/`daily`, `every week`/`weekly`.

### `telegram-list`, `telegram-cancel`, `telegram-history`

```bash
telegram-list                      # all pending/sent/failed scheduled messages
telegram-cancel <message_id>       # remove a pending one
telegram-history 50                # last 50 messages, both directions
```

## Full flow (chatbot template)

Drop this into any agent loop where you may need user input:

```bash
# 1. Pose the question
ANSWER=$(telegram-wait "Found 3 candidates for staging. Auto-pick highest-scoring? y/n" --timeout 1800)

# 2. Branch on the answer
case "$(echo "$ANSWER" | tr '[:upper:]' '[:lower:]')" in
  y|yes|da|ok)
    telegram-send "ok, picking highest-scoring one. Will ping again when staged."
    deploy_to_staging
    telegram-send "staging deploy done, monitoring metrics for 10m"
    ;;
  *)
    telegram-send "aborted. waiting for your direction."
    exit 0
    ;;
esac
```

If the user types `<agent-id>: stop` at any time outside a `wait`, it sits in inbound history; the next `telegram-wait` picks it up. You can also poll with `telegram-history` if you want to handle out-of-band messages.

## Install (one-time, per machine)

```bash
git clone <repo>
cd <repo>
bun install
bun link
telegram-setup "<bot_token>" "<user_id>" "<convex_deploy_key>"
```

Setup writes credentials to `~/.claude-telegram/config.json` (OS home, survives skill reinstalls), deploys the Convex backend, and registers the Telegram webhook for inbound capture.

**Critical first-time step**: open `@<your-bot>` in Telegram and press **Start**. Telegram refuses to deliver messages to a user who has never initiated the conversation.

## Multi-agent example

Two terminals, same Telegram chat, no collision:

```bash
# terminal A — cwd: E:\eve\eve
$ telegram-wait "shall I commit the WIP?"
# user sees: "[e-eve-eve] shall I commit the WIP?"

# terminal B — cwd: D:\Repos\my-bot
$ telegram-wait "ready to deploy?"
# user sees: "[d-repos-my-bot] ready to deploy?"

# user replies "e-eve-eve: yes go" → only terminal A unblocks
# user taps Reply on the my-bot message and types "no" → only terminal B unblocks
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `telegram-send` succeeds but Telegram never delivers | User never pressed Start on the bot | Open the bot in Telegram, press Start once. |
| `telegram-wait` times out even though you replied | Reply wasn't addressed to this agent | Prefix with the exact agent id (case-insensitive) followed by `:`/space, or tap-and-Reply to the agent's message. |
| Two agents fire at once and one blocks forever | They share a cwd and so share an agent id | Set `TELEGRAM_AGENT_ID=<unique>` in one of them. |
| Empty 404 from Convex | Deployment URL is missing the region segment in `~/.claude-telegram/config.json` | Re-run `telegram-setup`, or fix `convexUrl` to e.g. `https://<name>.eu-west-1.convex.cloud`. |
| `chat not found` | First-message restriction — see Install. | |
