#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  analyzeConversation,
  analyzeTranscriptFile,
  formatCost,
  formatPct,
  formatTokens,
} from '../sidecars/context_monitor/analyzer.mjs';

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

function getStateFile(overrideFile = '') {
  if (overrideFile) return overrideFile;
  const baseDir = process.env.PLUGIN_DATA || join(tmpdir(), 'antigravity-context-usage');
  return join(baseDir, 'alerts.json');
}

function loadState(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(stateFile, state) {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    const entries = Object.entries(state);
    const trimmed = entries.length > 200 ? Object.fromEntries(entries.slice(-150)) : state;
    writeFileSync(stateFile, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch {
    // Non-fatal: alert delivery must never break the agent loop.
  }
}

function tierFor(usedPercentage) {
  if (usedPercentage >= 90) return 90;
  if (usedPercentage >= 80) return 80;
  return 0;
}

export function evaluateContextHook(payload = {}, opts = {}) {
  const convId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
  const transcriptPath = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '';
  const modelName = typeof payload.modelName === 'string' ? payload.modelName : '';

  let analysis = null;
  if (transcriptPath) {
    analysis = analyzeTranscriptFile(transcriptPath, {
      modelId: modelName,
      windowSize: opts.windowSize,
    });
  }
  if (!analysis && convId) {
    analysis = analyzeConversation(convId, {
      includeSubagents: false,
      windowSize: opts.windowSize,
    });
  }
  if (!analysis) {
    return {};
  }

  const key = convId || transcriptPath || 'default';
  const stateFile = getStateFile(opts.stateFile);
  const state = loadState(stateFile);
  const prevTier = Number(state[key]?.tier) || 0;
  const usedPct = Number(analysis.usedPercentage) || 0;
  const currentTier = tierFor(usedPct);

  if (usedPct < 70 && prevTier > 0) {
    state[key] = { tier: 0, updatedAt: Date.now() };
    saveState(stateFile, state);
    return {};
  }

  if (currentTier > prevTier) {
    state[key] = { tier: currentTier, updatedAt: Date.now() };
    saveState(stateFile, state);

    const icon = currentTier >= 90 ? '🔴' : '🟡';
    const levelLabel = currentTier >= 90 ? 'Critical Context Alert' : 'High Context Usage Warning';
    const isCliSurface = String(transcriptPath || '').includes('antigravity-cli');
    const actionHint = isCliSurface
      ? 'Remaining headroom: **' +
        formatTokens(analysis.remainingTokens) +
        '**. Consider running `/compact` to summarize older turns, or inspect details with `:ctx` or `!ctx`.'
      : 'Remaining headroom: **' +
        formatTokens(analysis.remainingTokens) +
        '**. Consider running `/compact` to summarize older turns, or inspect details in [Context Usage](sidecar://context-usage/context_monitor/).';
    const estCost = `Est. session cost: **${formatCost(analysis.cost?.totalCostUsd)}**.`;
    const markdown = [
      `${icon} **${levelLabel}** — Active context is at **${formatPct(usedPct)}** (${formatTokens(analysis.activeContextTokens)} / ${formatTokens(analysis.contextWindowSize)}).`,
      `${estCost} ${actionHint}`,
    ].join('\n\n');

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: '',
            metadata: {
              user_markdown: markdown,
            },
          },
        },
      ],
    };
  }

  return {};
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const out = evaluateContextHook(payload);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    process.stdout.write('{}\n');
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-context.mjs');
if (isMain) {
  main();
}
