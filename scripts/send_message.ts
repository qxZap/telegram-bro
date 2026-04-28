#!/usr/bin/env bun

import { ConvexHttpClient } from 'convex/browser';
import { readFileSync, existsSync } from 'fs';
import { api } from '../convex/_generated/api.js';
import { Config, CONFIG_PATH, getConvexUrl } from './types.js';
import { setupProxy } from './proxy-util.js';
import { deriveAgentId } from './agent-id.js';
import {
  logError,
  logSuccess,
  logInfo,
  logDetail,
  logUsage,
  logNotConfigured,
} from './logger.js';

setupProxy();

const TELEGRAM_TEXT_LIMIT = 4096;

// Models often pass JSON-style escape sequences ("foo\\nbar") through
// CLI args or piped strings instead of real bytes. Translate the
// common ones so messages render with real newlines/tabs in Telegram.
// Two-char `\r\n` first so the single-char rule doesn't eat it.
function decodeLiteralEscapes(s: string): string {
  return s
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\r\n/g, '\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () =>
      resolve(Buffer.concat(chunks).toString('utf-8'))
    );
    process.stdin.on('error', reject);
  });
}

// Split a too-long message at the most natural boundary that still fits
// within Telegram's 4096-char text limit. Prefers newline, then space,
// then hard cut. Returns an array of one or more chunks.
function splitForTelegram(text: string, max: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < Math.floor(max / 2)) cut = rest.lastIndexOf(' ', max);
    if (cut < Math.floor(max / 2)) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

async function sendMessage(): Promise<void> {
  const argv = process.argv.slice(2);

  // Separate flags from positional args. The only flag right now is --help.
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      logUsage(
        'Usage: telegram-send [<text>|-] [<file>]\n' +
          '       echo <text> | telegram-send [<file>]\n' +
          '       telegram-send < message.txt',
        [
          'telegram-send "Hello"',
          'telegram-send "Caption" /path/to/report.pdf',
          'echo "long content here" | telegram-send',
          'telegram-send - report.pdf < notes.md',
        ]
      );
      process.exit(0);
    }
    positional.push(a);
  }

  // Decide whether to read stdin.
  // Stdin used when: no positional args, or first positional is "-".
  const useStdin = positional.length === 0 || positional[0] === '-';

  let messageText: string;
  let filePath: string | undefined;

  if (useStdin) {
    if ((process.stdin as any).isTTY) {
      logUsage(
        'No message provided. Pass it as an argument, pipe it on stdin, or pass "-" with stdin redirected.',
        [
          'telegram-send "Hello"',
          'echo "Hello" | telegram-send',
          'telegram-send - < message.txt',
        ]
      );
      process.exit(1);
    }
    messageText = (await readStdin()).replace(/\s+$/, '');
    filePath = positional[0] === '-' ? positional[1] : positional[0];
  } else {
    messageText = positional[0];
    filePath = positional[1];
  }

  if (!messageText) {
    logError('Empty message — nothing to send.');
    process.exit(1);
  }

  messageText = decodeLiteralEscapes(messageText);

  const agentId = deriveAgentId();
  const taggedMessage = `[${agentId}] ${messageText}`;

  if (!existsSync(CONFIG_PATH)) logNotConfigured();
  const config: Config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

  logInfo('📡', 'Connecting to Convex...');
  const deploymentUrl = getConvexUrl(config);
  logDetail(`→ URL: ${deploymentUrl}`);
  const client = new ConvexHttpClient(deploymentUrl);

  if (filePath && !existsSync(filePath)) {
    logError(`File not found: ${filePath}`);
    process.exit(1);
  }

  // File attachments must use the single-message path. Telegram caption
  // max is 1024 chars; trim caption rather than split when sending a file.
  if (filePath) {
    const trimmed =
      taggedMessage.length > 1024 ? taggedMessage.slice(0, 1021) + '...' : taggedMessage;
    if (trimmed.length < taggedMessage.length) {
      logDetail(
        `→ caption truncated from ${taggedMessage.length} to 1024 chars (Telegram limit)`
      );
    }
    logInfo('📤', `Sending as [${agentId}] with file...`);
    try {
      const uploadUrl = await client.mutation(api.messages.generateUploadUrl);
      const fileBuffer = readFileSync(filePath);
      const fileName = filePath.split(/[\\/]/).pop() || 'file';
      const fileBlob = new Blob([fileBuffer], { type: 'application/octet-stream' });
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: fileBlob,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.statusText}`);
      }
      const { storageId } = (await uploadResponse.json()) as { storageId: string };

      await client.action(api.telegram.sendMessage, {
        message_text: trimmed,
        storage_id: storageId,
        file_name: fileName,
      });
      logSuccess(`Message + file sent (${fileName}).`);
    } catch (error: any) {
      const detail = error?.data || error?.message || String(error) || 'unknown error';
      logError(`Failed to send: ${detail}`);
      if (error?.stack) console.error(error.stack);
      process.exit(1);
    }
    return;
  }

  // Text-only path: split body (without the prefix) so we can attach the
  // prefix to every chunk. That way reply-by-tap on any chunk still
  // resolves to this agent in getInboundForAgent.
  const prefix = `[${agentId}] `;
  const bodyChunks = splitForTelegram(messageText, TELEGRAM_TEXT_LIMIT - prefix.length - 8);
  const chunks =
    bodyChunks.length === 1
      ? [prefix + bodyChunks[0]]
      : bodyChunks.map((b, i) => `${prefix}(${i + 1}/${bodyChunks.length}) ${b}`);

  if (chunks.length > 1) {
    logDetail(
      `→ message length ${messageText.length} > ${TELEGRAM_TEXT_LIMIT - prefix.length - 8}, splitting into ${chunks.length} parts`
    );
  }
  logInfo('📤', `Sending as [${agentId}]${chunks.length > 1 ? ` (${chunks.length} parts)` : ''}...`);

  try {
    for (const chunk of chunks) {
      await client.action(api.telegram.sendMessage, { message_text: chunk });
    }
    logSuccess(
      chunks.length > 1
        ? `${chunks.length} messages sent successfully.`
        : 'Message sent successfully!'
    );
  } catch (error: any) {
    const detail = error?.data || error?.message || String(error) || 'unknown error';
    logError(`Failed to send: ${detail}`);
    if (error?.stack) console.error(error.stack);
    process.exit(1);
  }
}

sendMessage().catch((error: Error) => {
  logError(error.message);
  process.exit(1);
});
