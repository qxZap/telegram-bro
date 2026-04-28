---
name: telegram
description: Two-way Telegram channel for AI agents. Send messages, schedule reminders, and block-and-wait for the user's reply. Each agent identifies itself by its working-directory path so multiple agents on one machine can talk to the same user without crossing wires.
---

# Telegram Agent Channel

CLI tools that let any AI assistant message the user on Telegram and pause until the user answers, all from the terminal.

## These are shell commands

Every command below is invoked through your shell / bash tool. There is no MCP tool called `telegram`. If your harness rejects the call as an unknown tool, you tried to invoke it wrong — run it through bash. If your bash tool itself rejects the call (missing `description`, etc.), fix the bash invocation, do not fall back to printing a fake message to stdout — a printed line in the IDE is not a Telegram message.

## Commands

```
telegram-send "<text>" ["<file>"]
telegram-send - ["<file>"]                     # read text from stdin
echo "<text>" | telegram-send                  # same, via pipe
telegram-send < message.txt                    # same, via redirect
telegram-wait ["<prompt>"] [--timeout <sec>] [--poll <sec>]
telegram-schedule "<time>" "<title>" "<text>" ["<file>"]
telegram-list
telegram-cancel <message_id>
telegram-history [limit]
```

All commands work from any directory once installed.

## Long messages

For anything longer than a couple of sentences, or anything with quotes, URLs, parentheses, or other shell-hostile characters, **pipe via stdin** instead of cramming it into a CLI argument. Windows arg limits are ~8000 chars and quoting URLs is brittle. Stdin has no such limit and no escaping rules.

Telegram's hard limit is 4096 chars per message; `telegram-send` auto-splits longer text at line/word boundaries and prefixes each chunk `[<agent-id>] (i/N) ...` so reply-by-tap still works on any chunk.

File attachments cap at 1024-char captions; if you pass a file, the message text gets truncated to fit. To send a long body with a file, send the body via stdin first (no file), then a separate `telegram-send "<short caption>" <file>`.

## Agent identity

Each command derives an **agent id** from the current working directory.

| cwd                         | agent id            |
| --------------------------- | ------------------- |
| `E:\eve\eve`                | `e-eve-eve`         |
| `D:\Repos\my-bot`           | `d-repos-my-bot`    |
| `/home/me/proj`             | `home-me-proj`      |

Outgoing messages are auto-prefixed `[<agent-id>]`. `telegram-wait` only returns messages addressed to *this* agent. Override the auto-id with the env var `TELEGRAM_AGENT_ID=<custom>`.

## How the user replies

Two ways, both work:

1. **By prefix:** `e-eve-eve: yes proceed` (separators allowed: `:`, `,`, `;`, space).
2. **By replying** to the agent's message in the Telegram client (long-press → Reply, or swipe-to-reply on mobile). No prefix needed.

Anything else stays in `telegram-history` but does not unblock any waiting agent.

## Message rules

- Plain text only. No Markdown tricks.
- In conversational mode, one short message per turn — Telegram is a phone notification, not a blog.
- For data dumps (lists with URLs, search results, structured info), newlines and longer bodies are fine; pipe via stdin.
- One message per logical event — don't narrate your reasoning in three messages when one will do.
- **Never call `telegram-wait` without first firing a message.** Prefer the `telegram-wait "<prompt>"` form (which sends + waits in one call). Bare `telegram-wait` is only valid when you sent a message earlier in the same flow that the user might be replying to. Waiting on nothing is silently broken — the user has no way to know you expect input.

## Conversational mode

If the user says something like **"let's chat on Telegram"**, **"continue on Telegram"**, **"talk to me on Telegram"**, or otherwise asks to move the conversation off the terminal, enter a chat loop:

1. `telegram-wait "<your opening line>"` — sends and blocks for the reply.
2. Read the reply from stdout, formulate a response.
3. `telegram-wait "<next message>"` — sends and blocks again.
4. Repeat until the user explicitly ends the chat (e.g., they say "done", "thanks", "bye", "back to terminal"), or until a long stretch of silence makes it obvious they walked away.

Each `telegram-wait "..."` is one full turn: it both sends and receives. Do not call `telegram-send` followed by a separate `telegram-wait` — that's two operations where one suffices and risks dropping a fast reply.

In conversational mode keep messages even shorter than usual — one or two short sentences per turn, like a SMS exchange.

## Telegram mode (sticky)

If the user says **"telegram mode on"** (or any of: "telegram on", "telegram only", "go telegram", "stick to telegram"), enter sticky mode for the rest of the session. Rules:

1. **Every reply** to the user goes through `telegram-wait` (questions/conversation) or `telegram-send` (one-way deliveries). Do not reply in the IDE. The IDE is a worker pane only.
2. **Extras go first via `telegram-send`**, then the follow-up question (if any) goes through `telegram-wait`. So: search results, command outputs, file contents, status updates → `telegram-send`. The "anything else?" / "want me to continue?" / etc. → `telegram-wait`.
3. One `telegram-send` per coherent chunk. Don't spam multiple sends in a row.
4. Mode stays on for the **entire session**. Even after a task completes, the next user input is expected via Telegram, not the IDE — stay in the loop.
5. Mode ends only when the user says **"telegram mode off"**, **"back to terminal"**, **"back to ide"**, or similar explicit close. Acknowledge on Telegram, then resume IDE replies.

## Output of `telegram-wait`

- **stdout:** the reply text, prefix stripped, terminated with `\n` (capturable with `$()`).
- **stderr:** status lines.
- **exit codes:** `0` reply received · `124` timeout · `1`/`2` errors.
- **default timeout:** 10h. Use `--timeout 0` for unlimited.

## Examples (one-liners only)

```
telegram-send "deploy finished, all green"
telegram-send "report attached" /tmp/report.pdf
telegram-wait
telegram-wait "ready to push to prod?"
telegram-wait "y or n?" --timeout 300
telegram-schedule "in 10 minutes" "ping" "stand up"
telegram-schedule "every 2 hours" "hydrate" "drink water"
telegram-list
telegram-cancel <message_id>
telegram-history 20
```

Recurring strings accepted by `telegram-schedule`: `every minute`, `every 5 minutes`, `every 30 minutes`, `every hour`, `every 2 hours`, `every day`, `daily`, `every week`, `weekly`.

## Install (one-time per machine)

```
git clone <repo>
cd <repo>
bun install
bun link
telegram-setup "<bot_token>" "<user_id>" "<convex_deploy_key>"
```

Then open the bot in Telegram and press **Start** once. Telegram refuses to deliver messages to a user who has never initiated the conversation.

## Troubleshooting

| Symptom                                          | Fix                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `telegram-send` succeeds but nothing arrives     | Open the bot in Telegram and press Start once.                                                 |
| `telegram-wait` times out though you replied     | Prefix with the exact agent id, or tap-and-Reply to the agent's message.                       |
| Two agents share an id and one blocks forever    | Set `TELEGRAM_AGENT_ID=<unique>` in one of them.                                               |
| Empty 404 from Convex                            | `convexUrl` in `~/.claude-telegram/config.json` is missing the region segment. Re-run setup.   |
| `chat not found`                                 | Same as the first row — Start the bot.                                                         |
