#!/usr/bin/env bun

import { mkdirSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { SKILL_ROOT, CLAUDE_SKILL_DIR } from './types.js';
import { logSuccess, logError, logDetail } from './logger.js';

// Copy SKILL.md into Claude Code's user-level skills dir so every Claude Code
// instance on this machine picks up the telegram skill automatically.
try {
  mkdirSync(CLAUDE_SKILL_DIR, { recursive: true });
  copyFileSync(
    resolve(SKILL_ROOT, 'SKILL.md'),
    resolve(CLAUDE_SKILL_DIR, 'SKILL.md')
  );
  logSuccess(`Skill installed for Claude Code at ${CLAUDE_SKILL_DIR}`);
  logDetail('→ Restart Claude Code (or start a new session) to load it.');
} catch (error: any) {
  logError(`Failed to install skill: ${error.message}`);
  process.exit(1);
}
