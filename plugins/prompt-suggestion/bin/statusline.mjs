#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  displayWidth,
  getPreferences,
  sessionKeyFor,
  suggestForTranscriptFile,
  truncateDisplay,
} from '../sidecars/suggestion_panel/engine.mjs';

const ENV_USE_COLOR = !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function getAnsi(useColor) {
  return useColor
    ? { reset: '\x1b[0m', dim: '\x1b[2m', gray: '\x1b[90m' }
    : { reset: '', dim: '', gray: '' };
}

function readStdin() {
  return new Promise((resolveStdin) => {
    if (process.stdin.isTTY) {
      resolveStdin('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolveStdin(data));
    process.stdin.on('error', () => resolveStdin(data));
  });
}

function expandTilde(cmd, env = process.env) {
  const s = String(cmd || '').trim();
  if (!s) return '';
  const home = env?.HOME || homedir();
  if (s === '~') return home;
  if (s.startsWith('~/')) return join(home, s.slice(2));
  return s;
}

function resolveUpstreamCommand(opts = {}, env = process.env) {
  if (opts.upstreamCommand !== undefined) {
    return String(opts.upstreamCommand || '').trim();
  }
  if (env?.AGY_PROMPT_SUGGESTION_UPSTREAM !== undefined) {
    return String(env.AGY_PROMPT_SUGGESTION_UPSTREAM || '').trim();
  }
  const home = env?.HOME || homedir();
  const cfgPath =
    opts.upstreamConfigPath || join(home, '.gemini', 'antigravity-cli', 'prompt-suggestion-upstream.json');
  try {
    if (!existsSync(cfgPath)) return '';
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  } catch {
    return '';
  }
}

async function runUpstreamStatusline(rawCmd, payload, opts = {}, env = process.env) {
  if (!rawCmd || rawCmd.toLowerCase() === 'none') return '';
  if (rawCmd.includes('prompt-suggestion/bin/statusline')) return '';

  const expanded = expandTilde(rawCmd, env);
  if (!expanded) return '';

  // Fast in-process execution when chaining with sibling context-usage statusline (<2ms).
  if (
    expanded.endsWith('/context-usage/bin/statusline.mjs') ||
    expanded.endsWith('/context-usage/bin/statusline-detail')
  ) {
    const isDetail = expanded.endsWith('statusline-detail');
    const mjsPath = isDetail ? resolve(dirname(expanded), 'statusline.mjs') : expanded;
    if (existsSync(mjsPath)) {
      try {
        const mod = await import(pathToFileURL(mjsPath).href);
        if (typeof mod?.renderStatusline === 'function') {
          return String(mod.renderStatusline(payload, { detail: isDetail }) || '').replace(/\n+$/, '');
        }
      } catch {
        // Fall through to subprocess if dynamic import fails.
      }
    }
  }

  try {
    const res = spawnSync('sh', ['-c', expanded], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 35,
      env: opts.env || env,
    });
    if (res.status === 0 && typeof res.stdout === 'string') {
      return res.stdout.replace(/\n+$/, '');
    }
  } catch {
    // Upstream failure must never break the statusline.
  }
  return '';
}

function buildSuggestionLine(payload, opts = {}) {
  const rawState = String(payload?.state ?? payload?.agent_state ?? 'idle')
    .trim()
    .toLowerCase();
  if (rawState !== 'idle' && rawState !== '') {
    return '';
  }

  const transcriptPath =
    typeof payload?.transcript_path === 'string' ? payload.transcript_path : '';
  const convId =
    typeof payload?.conversation_id === 'string'
      ? payload.conversation_id
      : typeof payload?.conversationId === 'string'
        ? payload.conversationId
        : '';
  const cwd =
    (payload?.workspace && typeof payload.workspace === 'object' ? payload.workspace.current_dir : '') ||
    (typeof payload?.cwd === 'string' ? payload.cwd : '');

  const key = sessionKeyFor({ conversationId: convId, transcriptPath });
  const prefs = getPreferences(key, { stateDir: opts.stateDir });
  if (prefs.enabled === false) return '';

  let analysis = null;
  if (transcriptPath && existsSync(transcriptPath)) {
    analysis = suggestForTranscriptFile(transcriptPath, {
      conversationId: convId,
      cwd,
      stateDir: opts.stateDir,
    });
  } else if (prefs.cached) {
    analysis = prefs.cached;
  }

  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  if (!candidates.length) return '';

  const lastStepIndex = typeof analysis?.lastStepIndex === 'number' ? analysis.lastStepIndex : -1;
  if (prefs.dismissedStepIndex >= 0 && prefs.dismissedStepIndex === lastStepIndex) {
    return '';
  }

  const useColor = typeof opts.useColor === 'boolean' ? opts.useColor : ENV_USE_COLOR;
  const ansi = getAnsi(useColor);
  const hint =
    candidates.length === 2
      ? '[:s 发送 · :s 2 · :s clear]'
      : candidates.length > 2
        ? `[:s 发送 · :s 2..${candidates.length} · :s clear]`
        : '[:s 发送 · :s clear]';

  const maxCols = Math.max(36, Number(opts.columns || process.env.COLUMNS) || 96);
  const availableCols = Math.max(12, maxCols - 2 - 1 - displayWidth(hint));
  const truncatedText = truncateDisplay(candidates[0].text, availableCols);

  if (useColor) {
    return `${ansi.dim}⇢ ${truncatedText}${ansi.reset} ${ansi.gray}${hint}${ansi.reset}`;
  }
  return `⇢ ${truncatedText} ${hint}`;
}

export async function renderStatusline(payload = {}, opts = {}) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const env = opts.env || process.env;
  const upstreamCmd = resolveUpstreamCommand(opts, env);

  const [suggestionLine, upstreamOutput] = await Promise.all([
    Promise.resolve(buildSuggestionLine(data, opts)),
    runUpstreamStatusline(upstreamCmd, data, opts, env),
  ]);

  return [suggestionLine, upstreamOutput].filter(Boolean).join('\n');
}

export async function main() {
  try {
    const raw = await readStdin();
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const rendered = await renderStatusline(parsed);
    if (rendered) {
      process.stdout.write(`${rendered}\n`);
    }
  } catch {
    // Stay silent on malformed stdin to avoid corrupting the terminal statusline.
  }
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.endsWith('statusline.mjs')) {
  await main();
}
