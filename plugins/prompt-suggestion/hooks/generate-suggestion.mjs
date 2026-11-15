#!/usr/bin/env node
import { existsSync } from 'node:fs';
import {
  cacheSuggestions,
  sessionKeyFor,
  suggestForTranscriptFile,
} from '../sidecars/suggestion_panel/engine.mjs';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

export function evaluateStopHook(payload = {}, opts = {}) {
  try {
    const terminationReason = String(payload?.terminationReason || '');
    const error = String(payload?.error || '').trim();
    const transcriptPath = typeof payload?.transcriptPath === 'string' ? payload.transcriptPath : '';
    const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : '';
    const cwd =
      typeof payload?.cwd === 'string' && payload.cwd
        ? payload.cwd
        : Array.isArray(payload?.workspacePaths) && payload.workspacePaths[0]
          ? payload.workspacePaths[0]
          : '';

    if (terminationReason !== 'NO_TOOL_CALL' || error || !transcriptPath || !existsSync(transcriptPath)) {
      return {};
    }

    const analysis = suggestForTranscriptFile(transcriptPath, {
      conversationId,
      cwd,
      stateDir: opts.stateDir,
    });
    if (analysis) {
      const key = sessionKeyFor({ conversationId, transcriptPath });
      cacheSuggestions(key, analysis, { stateDir: opts.stateDir });
    }
  } catch {
    // Non-fatal: Stop hook must never block or fail the agent loop.
  }
  return {};
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const out = evaluateStopHook(payload);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    process.stdout.write('{}\n');
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('generate-suggestion.mjs');
if (isMain) {
  await main();
}
