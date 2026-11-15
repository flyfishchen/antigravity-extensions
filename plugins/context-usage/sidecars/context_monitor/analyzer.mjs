import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DEFAULT_REMOTE_PRICING_URL,
  WEEKLY_PRICING_CACHE_TTL_MS,
  calculateTurnCost,
  estimatePayloadCost,
  formatCost,
  getPricingCacheDir,
  getPricingCacheFilePath,
  getPricingSignature,
  loadCustomPricingOverrides,
  loadRemotePricingCache,
  parseNewApiRatioConfig,
  resolveModelPricing,
  syncRemotePricingCache,
} from './pricing.mjs';

export {
  DEFAULT_REMOTE_PRICING_URL,
  WEEKLY_PRICING_CACHE_TTL_MS,
  calculateTurnCost,
  estimatePayloadCost,
  formatCost,
  getPricingCacheDir,
  getPricingCacheFilePath,
  getPricingSignature,
  loadCustomPricingOverrides,
  loadRemotePricingCache,
  parseNewApiRatioConfig,
  resolveModelPricing,
  syncRemotePricingCache,
};

function roundUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e8) / 1e8;
}

const ID_RE = /^[0-9a-f-]{8,64}$/i;
const UUID_IN_TEXT_RE = /(?:conversation:\/\/|"conversationId"\s*:\s*"|conversationId=)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const MODEL_CHANGE_RE = /setting `Model Selection` from [^\n]+? to ([^.\n<]+)/i;
const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i;
const METADATA_BLOCK_RE = /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>/gi;

const DEFAULT_WINDOW_SIZE = 1_048_576;

const fileAnalysisCache = new Map(); // `${path}|${windowOverride}` -> { key, result }
const rawTextCache = new Map(); // path -> { key, text }

/**
 * Format a token count compactly for UI/CLI display (e.g. 26.4k, 1.05M).
 */
export function formatTokens(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return '0';
  if (num < 1000) return String(Math.round(num));
  if (num < 100_000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (num < 1_000_000) return `${Math.round(num / 1000)}k`;
  return `${(num / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/**
 * Format percentage cleanly (e.g. 2.5%, 84%).
 */
export function formatPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '0%';
  if (num < 10) return `${num.toFixed(1).replace(/\.0$/, '')}%`;
  return `${Math.round(num)}%`;
}

/**
 * Resolve model context window capacity from model ID / label / override.
 */
export function resolveContextWindowSize(modelId = '', modelLabel = '', overrideSize = 0) {
  const override = Number(overrideSize);
  if (Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }
  const combined = `${String(modelId || '')} ${String(modelLabel || '')}`.toLowerCase();
  if (!combined.trim()) return DEFAULT_WINDOW_SIZE;
  if (combined.includes('claude')) return 200_000;
  if (combined.includes('gpt-4o')) return 128_000;
  if (combined.includes('gpt-4.1')) return 1_047_576;
  if (/\bo[134](?:\b|-)/.test(combined)) return 200_000;
  if (
    combined.includes('gemini') ||
    combined.includes('hydrogen') ||
    combined.includes('carbon') ||
    combined.includes('orchestrator') ||
    combined.includes('flash') ||
    combined.includes('pro')
  ) {
    return DEFAULT_WINDOW_SIZE;
  }
  return DEFAULT_WINDOW_SIZE;
}

/**
 * Estimate token count for plain text, accounting for higher token density of CJK characters.
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || !text.length) return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkText = cjkCount > 0 ? text.replace(CJK_RE, '') : text;
  const nonCjkBytes = Buffer.byteLength(nonCjkText, 'utf8');
  const est = Math.ceil(cjkCount * 0.65 + nonCjkBytes * 0.25);
  return Math.max(1, est);
}

function safeReaddir(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    const s = statSync(filePath);
    return { exists: true, mtimeMs: s.mtimeMs, size: s.size, isDir: s.isDirectory() };
  } catch {
    return { exists: false, mtimeMs: 0, size: -1, isDir: false };
  }
}

function readCachedText(filePath) {
  const st = safeStat(filePath);
  if (!st.exists || st.size < 0) return { text: null, mtimeMs: 0, size: -1 };
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = rawTextCache.get(filePath);
  if (hit && hit.key === key) return { text: hit.text, mtimeMs: st.mtimeMs, size: st.size };
  try {
    const text = readFileSync(filePath, 'utf8');
    rawTextCache.set(filePath, { key, text });
    if (rawTextCache.size > 200) {
      const oldest = rawTextCache.keys().next().value;
      rawTextCache.delete(oldest);
    }
    return { text, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { text: null, mtimeMs: 0, size: -1 };
  }
}

/**
 * Identify product surface from an appData directory path.
 */
export function productOf(appDataPath) {
  const base = basename(String(appDataPath || ''));
  if (base === 'antigravity-cli') return 'cli';
  if (base === 'antigravity-ide') return 'ide';
  if (base === 'antigravity') return 'app';
  return base || 'unknown';
}

/**
 * Discover Antigravity appData directories containing brain/ transcripts.
 */
export function findAppDataDirs(env = process.env) {
  const seen = new Set();
  const out = [];

  const addCandidate = (dirPath) => {
    if (!dirPath) return;
    const resolved = resolve(dirPath);
    if (seen.has(resolved)) return;
    const brainStat = safeStat(join(resolved, 'brain'));
    if (brainStat.exists && brainStat.isDir) {
      seen.add(resolved);
      out.push(resolved);
    }
  };

  if (env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    let cur = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    while (cur && cur !== dirname(cur)) {
      if (basename(cur) === 'sidecar_data') {
        addCandidate(dirname(cur));
        break;
      }
      cur = dirname(cur);
    }
  }

  if (env?.ANTIGRAVITY_APP_DATA_DIR) {
    addCandidate(env.ANTIGRAVITY_APP_DATA_DIR);
  }

  const home = env?.HOME || homedir();
  const geminiRoot = join(home, '.gemini');
  const preferredOrder = ['antigravity', 'antigravity-cli', 'antigravity-ide'];
  for (const name of preferredOrder) {
    addCandidate(join(geminiRoot, name));
  }
  for (const name of safeReaddir(geminiRoot).sort()) {
    addCandidate(join(geminiRoot, name));
  }

  return out;
}

export function transcriptPathFor(appData, convId) {
  return join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
}

/**
 * Locate a conversation's appData directory and transcript path.
 */
export function locateConversation(convId, dirs = null, env = process.env) {
  if (!convId || !ID_RE.test(String(convId))) return null;
  const candidates = Array.isArray(dirs) && dirs.length ? dirs : findAppDataDirs(env);
  let fallback = null;

  for (const appData of candidates) {
    const tPath = transcriptPathFor(appData, convId);
    const tStat = safeStat(tPath);
    if (tStat.exists && tStat.size >= 0) {
      return {
        appData,
        product: productOf(appData),
        conversationId: convId,
        transcriptPath: tPath,
        mtimeMs: tStat.mtimeMs,
        size: tStat.size,
      };
    }
    if (!fallback) {
      const bStat = safeStat(join(appData, 'brain', convId));
      if (bStat.exists && bStat.isDir) {
        fallback = {
          appData,
          product: productOf(appData),
          conversationId: convId,
          transcriptPath: tPath,
          mtimeMs: bStat.mtimeMs,
          size: 0,
        };
      }
    }
  }

  return fallback;
}

function unquoteArg(val) {
  if (typeof val !== 'string') return val == null ? '' : String(val);
  const s = val.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function oneLine(str, maxLen = 80) {
  const clean = String(str || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

/**
 * Summarize a tool call cleanly for consumer attribution and turn history.
 */
export function describeToolCall(tc) {
  const name = String(tc?.name || '');
  if (!name) return '';
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  const summary = unquoteArg(args.toolSummary) || unquoteArg(args.toolAction);
  if (summary) return `${name}: ${oneLine(summary, 52)}`;
  const filePath = unquoteArg(args.Path || args.AbsolutePath || args.TargetFile || args.path);
  if (filePath) return `${name} ${basename(filePath)}`;
  const cmd = unquoteArg(args.CommandLine);
  if (cmd) return `${name}: ${oneLine(cmd, 46)}`;
  const query = unquoteArg(args.Query || args.query);
  if (query) return `${name}: ${oneLine(query, 46)}`;
  return name;
}

function extractUserTitle(content) {
  if (typeof content !== 'string' || !content.trim()) return '';
  const match = USER_REQUEST_RE.exec(content);
  const raw = match ? match[1] : content.replace(METADATA_BLOCK_RE, ' ');
  return oneLine(raw, 80);
}

function extractModelLabel(content) {
  if (typeof content !== 'string') return '';
  const m = MODEL_CHANGE_RE.exec(content);
  return m ? m[1].trim() : '';
}

function estimateStepTextTokens(step) {
  let text = '';
  if (typeof step?.content === 'string') text += step.content;
  if (typeof step?.thinking === 'string') text += `\n${step.thinking}`;
  if (Array.isArray(step?.tool_calls)) {
    try {
      text += `\n${JSON.stringify(step.tool_calls)}`;
    } catch {
      // ignore non-serializable tool calls
    }
  }
  return estimateTextTokens(text);
}

function isPlanReviewSystemMessage(step) {
  return (
    (step?.type === 'SYSTEM_MESSAGE' || step?.source === 'SYSTEM') &&
    typeof step?.content === 'string' &&
    step.content.includes('[plan review]')
  );
}

function advancePhaseState(step, phaseState) {
  if (!step || typeof step !== 'object') return;
  if (step.type === 'USER_INPUT') {
    const changed = extractModelLabel(step.content);
    if (changed) phaseState.runningModelLabel = changed;
    phaseState.runningPhase = 'planner';
  } else if (isPlanReviewSystemMessage(step)) {
    phaseState.runningPhase = 'planner';
  }
}

function ensureModelStatsEntry(map, { key, role, label, rawModel = '' }) {
  let entry = map.get(key);
  if (!entry) {
    entry = {
      key,
      role,
      label,
      model: rawModel || '',
      models: new Set(rawModel ? [rawModel] : []),
      invocations: 0,
      uncachedInputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      inputCostUsd: 0,
      cacheReadCostUsd: 0,
      outputCostUsd: 0,
      cacheSavingsUsd: 0,
    };
    map.set(key, entry);
  } else if (rawModel) {
    entry.model = rawModel;
    entry.models.add(rawModel);
  }
  return entry;
}

function healthStatusOf(usedPercentage) {
  if (usedPercentage >= 90) return 'critical';
  if (usedPercentage >= 80) return 'warning';
  if (usedPercentage >= 60) return 'moderate';
  return 'healthy';
}

function deductProportionally(buckets, amount) {
  let rem = Math.max(0, Math.round(amount));
  if (rem === 0) return;

  const order = ['modelOutputs', 'toolResults', 'userInputs', 'systemAndTools'];
  const dynamicSum = buckets.modelOutputs + buckets.toolResults + buckets.userInputs;
  if (dynamicSum >= rem && dynamicSum > 0) {
    let deducted = 0;
    for (const key of ['modelOutputs', 'toolResults', 'userInputs']) {
      const share = Math.min(buckets[key], Math.round((buckets[key] / dynamicSum) * rem));
      buckets[key] -= share;
      deducted += share;
    }
    let left = rem - deducted;
    for (const key of order) {
      if (left <= 0) break;
      const take = Math.min(buckets[key], left);
      buckets[key] -= take;
      left -= take;
    }
    return;
  }

  for (const key of order) {
    if (rem <= 0) break;
    const take = Math.min(buckets[key], rem);
    buckets[key] -= take;
    rem -= take;
  }
}

/**
 * Analyze raw transcript.jsonl content and produce exact context & token breakdown.
 */
export function analyzeTranscriptText(jsonlText, opts = {}) {
  const steps = [];
  for (const line of String(jsonlText || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        steps.push(obj);
      }
    } catch {
      // Tolerate torn final line while transcript is being flushed.
    }
  }

  let title = '';
  let modelId = '';
  let modelLabel = '';
  let lastActivityAt = '';
  let sawOrchestratorSignal =
    /orchestrator/i.test(String(opts.modelLabel || '')) ||
    /orchestrator|-worker/i.test(String(opts.modelId || ''));
  const plannerIndices = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (typeof s.created_at === 'string' && s.created_at) {
      lastActivityAt = s.created_at;
    }
    if (s.type === 'USER_INPUT') {
      if (!title) title = extractUserTitle(s.content);
      const changed = extractModelLabel(s.content);
      if (changed) {
        modelLabel = changed;
        if (/orchestrator/i.test(changed)) sawOrchestratorSignal = true;
      }
    }
    if (isPlanReviewSystemMessage(s)) {
      sawOrchestratorSignal = true;
    }
    if (s.type === 'PLANNER_RESPONSE') {
      if (typeof s.model === 'string' && s.model) {
        modelId = s.model;
        if (/orchestrator|-worker/i.test(s.model)) sawOrchestratorSignal = true;
      }
      if (
        Array.isArray(s.tool_calls) &&
        s.tool_calls.some((tc) => tc?.name === 'exit_plan_mode')
      ) {
        sawOrchestratorSignal = true;
      }
      const hasTokenFields =
        typeof s.input_tokens === 'number' ||
        typeof s.cache_read_tokens === 'number' ||
        typeof s.cache_creation_input_tokens === 'number';
      if (hasTokenFields) {
        plannerIndices.push(i);
      }
    }
  }

  const buckets = {
    systemAndTools: 0,
    userInputs: 0,
    modelOutputs: 0,
    toolResults: 0,
  };

  const sessionTotals = {
    invocations: plannerIndices.length,
    totalSteps: steps.length,
    uncachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalInputTokens: 0,
    outputTokens: 0,
    cacheHitRate: 0,
    latestTurnCacheHitRate: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
  };

  const overrides = loadCustomPricingOverrides(opts);
  const remoteCache = loadRemotePricingCache(opts);
  const costAcc = {
    freshInputCostUsd: 0,
    cacheWriteCostUsd: 0,
    cacheReadCostUsd: 0,
    outputCostUsd: 0,
    totalCostUsd: 0,
    uncachedEquivalentCostUsd: 0,
    cacheSavingsUsd: 0,
    longContextTurns: 0,
    hasEstimatedFallback: false,
    sawCustomPricing: false,
    sawRemotePricing: false,
  };

  const turns = [];
  const consumerCandidates = [];
  const modelStatsMap = new Map();
  let switchCount = 0;

  let lastPromptTokens = 0;
  let lastOutputTokens = 0;

  if (plannerIndices.length === 0) {
    for (const s of steps) {
      const est = estimateStepTextTokens(s);
      if (s.type === 'USER_INPUT') buckets.userInputs += est;
      else if (s.type === 'PLANNER_RESPONSE') buckets.modelOutputs += est;
      else buckets.toolResults += est;
    }
  } else {
    let prevPromptTokens = 0;
    let prevOutputTokens = 0;
    let stepCursor = 0;
    let prevGroupKey = '';
    let lastSeenStepCreatedAt = '';
    const phaseState = {
      runningModelLabel: opts.modelLabel || '',
      runningPhase: 'planner',
    };

    for (let t = 0; t < plannerIndices.length; t++) {
      const currIdx = plannerIndices[t];
      const currStep = steps[currIdx];

      while (stepCursor <= currIdx) {
        const st = steps[stepCursor++];
        if (typeof st?.created_at === 'string' && st.created_at.trim()) {
          lastSeenStepCreatedAt = st.created_at.trim();
        }
        advancePhaseState(st, phaseState);
      }

      const rawModel = typeof currStep.model === 'string' ? currStep.model.trim() : '';
      const turnIsOrchestrator =
        sawOrchestratorSignal &&
        (!phaseState.runningModelLabel ||
          /orchestrator/i.test(phaseState.runningModelLabel) ||
          /orchestrator|-worker/i.test(rawModel));

      let modelRole = 'single';
      let modelRoleLabel = phaseState.runningModelLabel || rawModel || 'Model';
      let modelTag = '';
      let groupKey = '';

      if (turnIsOrchestrator) {
        if (/orchestrator|planner/i.test(rawModel)) {
          modelRole = 'planner';
        } else if (/worker|executor/i.test(rawModel)) {
          modelRole = 'worker';
        } else {
          modelRole = phaseState.runningPhase;
        }
        groupKey = `role:${modelRole}`;
        modelRoleLabel = modelRole === 'planner' ? 'Planner' : 'Worker';
        modelTag = modelRole === 'planner' ? 'PLAN' : 'EXEC';
      } else {
        const singleKey = rawModel || phaseState.runningModelLabel || opts.modelId || 'unknown';
        groupKey = `model:${singleKey}`;
      }

      const modelSwitched = t > 0 && groupKey !== prevGroupKey;
      if (modelSwitched) switchCount += 1;
      prevGroupKey = groupKey;

      const inputTokens = Number(currStep.input_tokens) || 0;
      const cacheReadTokens = Number(currStep.cache_read_tokens) || 0;
      const cacheCreationTokens = Number(currStep.cache_creation_input_tokens) || 0;
      const uncached = inputTokens + cacheCreationTokens;
      const promptTokens = uncached + cacheReadTokens;
      const outputTokens = Number(currStep.output_tokens) || 0;
      const turnCacheHitRate = promptTokens > 0 ? (cacheReadTokens / promptTokens) * 100 : 0;

      const turnPricing = resolveModelPricing({
        rawModel,
        modelLabel: phaseState.runningModelLabel || modelLabel || opts.modelLabel || opts.modelId || '',
        role: modelRole,
        isOrchestrator: turnIsOrchestrator,
        overrides,
        remoteModels: remoteCache?.models || null,
        env: opts.env,
        cacheDir: opts.cacheDir,
      });
      if (turnPricing.pricingSource === 'custom') costAcc.sawCustomPricing = true;
      else if (turnPricing.pricingSource === 'remote-cache') costAcc.sawRemotePricing = true;
      const turnCost = calculateTurnCost(
        {
          freshInputTokens: inputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          outputTokens,
          promptTokens,
        },
        turnPricing
      );

      const modelEntry = ensureModelStatsEntry(modelStatsMap, {
        key: groupKey,
        role: modelRole,
        label: modelRoleLabel,
        rawModel,
      });
      modelEntry.invocations += 1;
      modelEntry.uncachedInputTokens += uncached;
      modelEntry.cacheCreationTokens += cacheCreationTokens;
      modelEntry.cacheReadTokens += cacheReadTokens;
      modelEntry.totalInputTokens += promptTokens;
      modelEntry.outputTokens += outputTokens;
      modelEntry.costUsd += turnCost.totalCostUsd;
      modelEntry.inputCostUsd += turnCost.inputCostUsd;
      modelEntry.cacheReadCostUsd += turnCost.cacheReadCostUsd;
      modelEntry.outputCostUsd += turnCost.outputCostUsd;
      modelEntry.cacheSavingsUsd += turnCost.cacheSavingsUsd;

      sessionTotals.uncachedInputTokens += uncached;
      sessionTotals.cacheCreationTokens += cacheCreationTokens;
      sessionTotals.cacheReadTokens += cacheReadTokens;
      sessionTotals.totalInputTokens += promptTokens;
      sessionTotals.outputTokens += outputTokens;
      sessionTotals.costUsd += turnCost.totalCostUsd;
      sessionTotals.cacheSavingsUsd += turnCost.cacheSavingsUsd;

      costAcc.freshInputCostUsd += turnCost.freshInputCostUsd;
      costAcc.cacheWriteCostUsd += turnCost.cacheWriteCostUsd;
      costAcc.cacheReadCostUsd += turnCost.cacheReadCostUsd;
      costAcc.outputCostUsd += turnCost.outputCostUsd;
      costAcc.totalCostUsd += turnCost.totalCostUsd;
      costAcc.uncachedEquivalentCostUsd += turnCost.uncachedEquivalentCostUsd;
      costAcc.cacheSavingsUsd += turnCost.cacheSavingsUsd;
      if (turnCost.longContextTier) costAcc.longContextTurns += 1;
      if (turnPricing.isFallback) costAcc.hasEstimatedFallback = true;

      const startSlice = t === 0 ? 0 : plannerIndices[t - 1] + 1;
      const interSteps = steps.slice(startSlice, currIdx);

      let interUserEst = 0;
      let interToolEst = 0;
      let interUserSnippet = '';
      for (const is of interSteps) {
        const est = estimateStepTextTokens(is);
        if (is.type === 'USER_INPUT') {
          interUserEst += est;
          if (!interUserSnippet) interUserSnippet = extractUserTitle(is.content);
        } else {
          interToolEst += est;
        }
      }

      const currToolCalls = Array.isArray(currStep.tool_calls)
        ? currStep.tool_calls.map(describeToolCall).filter(Boolean)
        : [];
      const prevToolCalls =
        t > 0 && Array.isArray(steps[plannerIndices[t - 1]].tool_calls)
          ? steps[plannerIndices[t - 1]].tool_calls.map(describeToolCall).filter(Boolean)
          : [];

      let deltaTokens = promptTokens;
      let compacted = false;

      if (t === 0) {
        const initialTotalEst = interUserEst + interToolEst;
        if (promptTokens >= initialTotalEst) {
          buckets.systemAndTools = promptTokens - initialTotalEst;
          buckets.userInputs = interUserEst;
          buckets.toolResults = interToolEst;
        } else {
          buckets.systemAndTools = 0;
          buckets.userInputs = Math.min(promptTokens, interUserEst);
          buckets.toolResults = Math.max(0, promptTokens - buckets.userInputs);
        }
        buckets.modelOutputs = outputTokens;
      } else {
        deltaTokens = promptTokens - (prevPromptTokens + prevOutputTokens);
        compacted = promptTokens < prevPromptTokens * 0.7;

        if (compacted) {
          buckets.systemAndTools = Math.min(buckets.systemAndTools, promptTokens);
          const remainingForHistory = Math.max(0, promptTokens - buckets.systemAndTools);
          const allocUser = Math.min(remainingForHistory, interUserEst);
          const allocTool = Math.min(Math.max(0, remainingForHistory - allocUser), interToolEst);
          const compactedSummaryTokens = Math.max(0, remainingForHistory - allocUser - allocTool);
          buckets.userInputs = allocUser;
          buckets.toolResults = allocTool;
          buckets.modelOutputs = compactedSummaryTokens + outputTokens;
        } else {
          if (deltaTokens >= 0) {
            if (interUserEst + interToolEst > 0) {
              const userShare = Math.round(
                deltaTokens * (interUserEst / (interUserEst + interToolEst))
              );
              const toolShare = deltaTokens - userShare;
              buckets.userInputs += userShare;
              buckets.toolResults += toolShare;
            } else if (prevToolCalls.length > 0) {
              buckets.toolResults += deltaTokens;
            } else {
              buckets.systemAndTools += deltaTokens;
            }
          } else {
            deductProportionally(buckets, -deltaTokens);
          }
          buckets.modelOutputs += outputTokens;
        }

        if (deltaTokens > 0) {
          const consumerLabel = prevToolCalls.length
            ? prevToolCalls.slice(0, 3).join(', ') +
              (prevToolCalls.length > 3 ? ` +${prevToolCalls.length - 3} more` : '')
            : interUserSnippet || `Turn ${t + 1} input`;
          consumerCandidates.push({
            turnNumber: t + 1,
            stepIndex: currStep.step_index ?? currIdx,
            deltaTokens,
            costUsd: turnCost.totalCostUsd,
            label: consumerLabel,
            createdAt: currStep.created_at || '',
          });
        }
      }

      turns.push({
        turnNumber: t + 1,
        stepIndex: currStep.step_index ?? currIdx,
        createdAt:
          (typeof currStep.created_at === 'string' && currStep.created_at.trim()) ||
          lastSeenStepCreatedAt ||
          '',
        model: rawModel || modelId || '',
        rawModel,
        modelRole,
        modelRoleLabel,
        modelTag,
        modelSwitched,
        inputTokens: uncached,
        freshInputTokens: inputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        outputTokens,
        promptTokens,
        deltaTokens,
        cacheHitRate: Number(turnCacheHitRate.toFixed(1)),
        compacted,
        tools: currToolCalls,
        pricingModel: turnPricing.pricingId,
        longContextTier: turnCost.longContextTier,
        costUsd: turnCost.totalCostUsd,
        inputCostUsd: turnCost.inputCostUsd,
        cacheReadCostUsd: turnCost.cacheReadCostUsd,
        outputCostUsd: turnCost.outputCostUsd,
        cacheSavingsUsd: turnCost.cacheSavingsUsd,
      });

      if (
        Array.isArray(currStep.tool_calls) &&
        currStep.tool_calls.some((tc) => tc?.name === 'exit_plan_mode')
      ) {
        phaseState.runningPhase = 'worker';
      }

      prevPromptTokens = promptTokens;
      prevOutputTokens = outputTokens;
      lastPromptTokens = promptTokens;
      lastOutputTokens = outputTokens;
    }

    while (stepCursor < steps.length) {
      advancePhaseState(steps[stepCursor++], phaseState);
    }

    const lastIdx = plannerIndices[plannerIndices.length - 1];
    let trailingUserTokens = 0;
    let trailingToolTokens = 0;
    for (const s of steps.slice(lastIdx + 1)) {
      const est = estimateStepTextTokens(s);
      if (s.type === 'USER_INPUT') trailingUserTokens += est;
      else if (s.type !== 'PLANNER_RESPONSE') trailingToolTokens += est;
    }

    buckets.userInputs += trailingUserTokens;
    buckets.toolResults += trailingToolTokens;

    sessionTotals.cacheHitRate =
      sessionTotals.totalInputTokens > 0
        ? Number(((sessionTotals.cacheReadTokens / sessionTotals.totalInputTokens) * 100).toFixed(1))
        : 0;
    sessionTotals.latestTurnCacheHitRate = turns.length ? turns[turns.length - 1].cacheHitRate : 0;
    sessionTotals.costUsd = roundUsd(sessionTotals.costUsd);
    sessionTotals.cacheSavingsUsd = roundUsd(sessionTotals.cacheSavingsUsd);
  }

  const activeContextTokens =
    buckets.systemAndTools + buckets.userInputs + buckets.modelOutputs + buckets.toolResults;

  if (consumerCandidates.length === 0 && turns.length > 0 && turns[0].promptTokens > 0) {
    consumerCandidates.push({
      turnNumber: 1,
      stepIndex: turns[0].stepIndex,
      deltaTokens: turns[0].promptTokens,
      costUsd: turns[0].costUsd || 0,
      label: title || 'Initial system + prompt',
      createdAt: turns[0].createdAt,
    });
  }

  const topConsumers = consumerCandidates
    .slice()
    .sort((a, b) => b.deltaTokens - a.deltaTokens)
    .slice(0, 8);

  const resolvedModelId = modelId || opts.modelId || '';
  const resolvedModelLabel = modelLabel || opts.modelLabel || resolvedModelId || 'Unknown';
  const contextWindowSize = resolveContextWindowSize(
    resolvedModelId,
    resolvedModelLabel,
    opts.windowSize
  );

  if (sawOrchestratorSignal) {
    ensureModelStatsEntry(modelStatsMap, {
      key: 'role:planner',
      role: 'planner',
      label: 'Planner',
    });
    ensureModelStatsEntry(modelStatsMap, {
      key: 'role:worker',
      role: 'worker',
      label: 'Worker',
    });
  }

  const rawModelEntries = [...modelStatsMap.values()];
  if (sawOrchestratorSignal) {
    const roleRank = { planner: 0, worker: 1, single: 2 };
    rawModelEntries.sort((a, b) => (roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9));
  }

  const grandModelTokens = rawModelEntries.reduce(
    (sum, e) => sum + e.totalInputTokens + e.outputTokens,
    0
  );
  const grandModelCost = rawModelEntries.reduce((sum, e) => sum + e.costUsd, 0);

  const modelEntries = rawModelEntries.map((e) => {
    const totalTokens = e.totalInputTokens + e.outputTokens;
    return {
      key: e.key,
      role: e.role,
      label: e.label,
      model: e.model,
      models: [...e.models],
      invocations: e.invocations,
      uncachedInputTokens: e.uncachedInputTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      cacheReadTokens: e.cacheReadTokens,
      totalInputTokens: e.totalInputTokens,
      outputTokens: e.outputTokens,
      totalTokens,
      cacheHitRate:
        e.totalInputTokens > 0
          ? Number(((e.cacheReadTokens / e.totalInputTokens) * 100).toFixed(1))
          : 0,
      sharePercentage:
        grandModelTokens > 0
          ? Number(((totalTokens / grandModelTokens) * 100).toFixed(1))
          : 0,
      costUsd: roundUsd(e.costUsd),
      inputCostUsd: roundUsd(e.inputCostUsd),
      cacheReadCostUsd: roundUsd(e.cacheReadCostUsd),
      outputCostUsd: roundUsd(e.outputCostUsd),
      cacheSavingsUsd: roundUsd(e.cacheSavingsUsd),
      costSharePercentage:
        grandModelCost > 0
          ? Number(((e.costUsd / grandModelCost) * 100).toFixed(1))
          : 0,
    };
  });

  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const modelBreakdown = {
    isOrchestrator: Boolean(sawOrchestratorSignal),
    isMultiModel: Boolean(sawOrchestratorSignal || modelEntries.length > 1),
    switchCount,
    activeRole: lastTurn ? lastTurn.modelRole : (sawOrchestratorSignal ? 'planner' : 'single'),
    activeRoleLabel: lastTurn
      ? lastTurn.modelRoleLabel
      : (sawOrchestratorSignal ? 'Planner' : resolvedModelLabel),
    activeTag: lastTurn ? lastTurn.modelTag : (sawOrchestratorSignal ? 'PLAN' : ''),
    activeModel: lastTurn ? (lastTurn.rawModel || lastTurn.model) : resolvedModelId,
    models: modelEntries,
  };

  const usedPercentage =
    contextWindowSize > 0
      ? Number(Math.min(100, (activeContextTokens / contextWindowSize) * 100).toFixed(2))
      : 0;
  const remainingPercentage = Number(Math.max(0, 100 - usedPercentage).toFixed(2));
  const remainingTokens = Math.max(0, contextWindowSize - activeContextTokens);
  const exceeds200k = activeContextTokens > 200_000;

  const pctOfActive = (val) =>
    activeContextTokens > 0 ? Number(((val / activeContextTokens) * 100).toFixed(1)) : 0;

  const totalCostUsd = roundUsd(costAcc.totalCostUsd);
  const freshInputCostUsd = roundUsd(costAcc.freshInputCostUsd);
  const cacheWriteCostUsd = roundUsd(costAcc.cacheWriteCostUsd);
  const inputCostUsd = roundUsd(costAcc.freshInputCostUsd + costAcc.cacheWriteCostUsd);
  const cacheReadCostUsd = roundUsd(costAcc.cacheReadCostUsd);
  const outputCostUsd = roundUsd(costAcc.outputCostUsd);
  const uncachedEquivalentCostUsd = roundUsd(costAcc.uncachedEquivalentCostUsd);
  const cacheSavingsUsd = roundUsd(costAcc.cacheSavingsUsd);
  const cacheSavingsPercentage =
    costAcc.uncachedEquivalentCostUsd > 0
      ? Number(((costAcc.cacheSavingsUsd / costAcc.uncachedEquivalentCostUsd) * 100).toFixed(1))
      : 0;
  const avgTurnCostUsd = turns.length > 0 ? roundUsd(costAcc.totalCostUsd / turns.length) : 0;
  const latestTurnCostUsd = turns.length > 0 ? roundUsd(turns[turns.length - 1].costUsd) : 0;

  return {
    title: title || 'Untitled conversation',
    model: resolvedModelId,
    modelLabel: resolvedModelLabel,
    modelBreakdown,
    lastActivityAt,
    contextWindowSize,
    activeContextTokens,
    remainingTokens,
    usedPercentage,
    remainingPercentage,
    exceeds200k,
    health: healthStatusOf(usedPercentage),
    categories: {
      systemAndTools: {
        tokens: buckets.systemAndTools,
        percentage: pctOfActive(buckets.systemAndTools),
      },
      userInputs: {
        tokens: buckets.userInputs,
        percentage: pctOfActive(buckets.userInputs),
      },
      modelOutputs: {
        tokens: buckets.modelOutputs,
        percentage: pctOfActive(buckets.modelOutputs),
      },
      toolResults: {
        tokens: buckets.toolResults,
        percentage: pctOfActive(buckets.toolResults),
      },
    },
    sessionTotals,
    cost: {
      currency: 'USD',
      totalCostUsd,
      inputCostUsd,
      freshInputCostUsd,
      cacheWriteCostUsd,
      cacheReadCostUsd,
      outputCostUsd,
      uncachedEquivalentCostUsd,
      cacheSavingsUsd,
      cacheSavingsPercentage,
      avgTurnCostUsd,
      latestTurnCostUsd,
      longContextTurns: costAcc.longContextTurns,
      hasEstimatedFallback: costAcc.hasEstimatedFallback,
      pricingSource: costAcc.sawCustomPricing
        ? 'custom'
        : costAcc.sawRemotePricing
          ? 'remote-cache'
          : 'builtin',
      pricingCache: remoteCache
        ? {
            sourceUrl: remoteCache.sourceUrl,
            fetchedAt: remoteCache.fetchedAt,
            downloadedAt: remoteCache.downloadedAt,
            checkedAt: remoteCache.checkedAt,
            lastModified: remoteCache.lastModified,
            expiresAt: remoteCache.expiresAt,
            stale: remoteCache.stale,
            modelCount: remoteCache.modelCount,
          }
        : null,
      subagentsCostUsd: 0,
      totalWithSubagentsUsd: totalCostUsd,
    },
    turns,
    topConsumers,
    _steps: opts.includeRawSteps ? steps : undefined,
  };
}

function extractReferencedConversationIds(steps, parentConvId) {
  const ids = new Set();
  for (const s of steps) {
    const blobs = [];
    if (typeof s.content === 'string') blobs.push(s.content);
    if (Array.isArray(s.tool_calls)) {
      for (const tc of s.tool_calls) {
        if (tc?.args) {
          try {
            blobs.push(JSON.stringify(tc.args));
          } catch {
            // ignore
          }
        }
      }
    }
    for (const blob of blobs) {
      UUID_IN_TEXT_RE.lastIndex = 0;
      let match;
      while ((match = UUID_IN_TEXT_RE.exec(blob)) !== null) {
        const candidate = match[1];
        if (candidate && candidate !== parentConvId) {
          ids.add(candidate);
        }
      }
    }
  }
  return [...ids];
}

function readSwarmMembers(appData, convId) {
  if (!appData || !convId) return [];
  const membersFile = join(appData, 'brain', convId, '.system_generated', 'swarm', 'members.json');
  const { text } = readCachedText(membersFile);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const members = parsed?.members;
    if (!members || typeof members !== 'object') return [];
    return Object.entries(members)
      .map(([name, m]) => ({
        name,
        role: typeof m?.role === 'string' ? m.role : 'worker',
        conversationId: typeof m?.conversation_id === 'string' ? m.conversation_id : '',
        killed: Boolean(m?.killed),
      }))
      .filter((m) => m.conversationId && m.conversationId !== convId);
  } catch {
    return [];
  }
}

/**
 * Analyze a transcript.jsonl file by path, with mtime+size memoization.
 */
export function analyzeTranscriptFile(filePath, opts = {}) {
  const st = safeStat(filePath);
  if (!st.exists || st.size < 0) return null;

  const cacheKey = `${filePath}|${Number(opts.windowSize) || 0}|${Boolean(opts.includeRawSteps)}|${getPricingSignature(opts)}`;
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = fileAnalysisCache.get(cacheKey);
  if (hit && hit.key === key) {
    return hit.result;
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const result = analyzeTranscriptText(text, opts);
  result.transcriptPath = filePath;
  result.mtimeMs = st.mtimeMs;
  result.fileSize = st.size;

  fileAnalysisCache.set(cacheKey, { key, result });
  if (fileAnalysisCache.size > 200) {
    const oldest = fileAnalysisCache.keys().next().value;
    fileAnalysisCache.delete(oldest);
  }
  return result;
}

/**
 * Analyze a conversation by ID across discovered Antigravity appData directories.
 */
export function analyzeConversation(convId, opts = {}) {
  const loc = locateConversation(convId, opts.dirs || null, opts.env || process.env);
  if (!loc) return null;

  const includeSubagents = opts.includeSubagents !== false;
  const parsed = analyzeTranscriptFile(loc.transcriptPath, {
    modelId: opts.modelId,
    windowSize: opts.windowSize,
    includeRawSteps: includeSubagents,
    pricing: opts.pricing,
    env: opts.env,
    cacheDir: opts.cacheDir,
    disableRemoteRefresh: opts.disableRemoteRefresh,
  });

  if (!parsed) {
    return {
      conversationId: convId,
      product: loc.product,
      appData: loc.appData,
      transcriptPath: loc.transcriptPath,
      mtimeMs: loc.mtimeMs,
      ...analyzeTranscriptText('', {
        modelId: opts.modelId,
        windowSize: opts.windowSize,
        pricing: opts.pricing,
        env: opts.env,
        cacheDir: opts.cacheDir,
        disableRemoteRefresh: opts.disableRemoteRefresh,
      }),
      subagents: [],
      subagentsTotals: {
        count: 0,
        activeContextTokens: 0,
        totalInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        cacheSavingsUsd: 0,
      },
    };
  }

  const { _steps, ...baseResult } = parsed;
  const out = {
    conversationId: convId,
    product: loc.product,
    appData: loc.appData,
    ...baseResult,
    subagents: [],
    subagentsTotals: {
      count: 0,
      activeContextTokens: 0,
      totalInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      cacheSavingsUsd: 0,
    },
  };

  if (includeSubagents) {
    const childMeta = new Map(); // convId -> { name, role, killed }
    for (const m of readSwarmMembers(loc.appData, convId)) {
      childMeta.set(m.conversationId, { name: m.name, role: m.role, killed: m.killed });
    }
    if (Array.isArray(_steps)) {
      for (const refId of extractReferencedConversationIds(_steps, convId)) {
        if (!childMeta.has(refId)) {
          childMeta.set(refId, { name: '', role: 'subagent', killed: false });
        }
      }
    }

    const dirs = opts.dirs || findAppDataDirs(opts.env || process.env);
    for (const [childId, meta] of childMeta.entries()) {
      const childLoc = locateConversation(childId, dirs, opts.env || process.env);
      if (!childLoc) continue;
      const childParsed = analyzeTranscriptFile(childLoc.transcriptPath, {
        windowSize: opts.windowSize,
        includeRawSteps: false,
        pricing: opts.pricing,
        env: opts.env,
        cacheDir: opts.cacheDir,
        disableRemoteRefresh: opts.disableRemoteRefresh,
      });
      if (!childParsed) continue;
      out.subagents.push({
        conversationId: childId,
        name: meta.name || childParsed.title || childId.slice(0, 8),
        role: meta.role,
        killed: meta.killed,
        product: childLoc.product,
        model: childParsed.model,
        modelLabel: childParsed.modelLabel,
        activeContextTokens: childParsed.activeContextTokens,
        contextWindowSize: childParsed.contextWindowSize,
        usedPercentage: childParsed.usedPercentage,
        totalInputTokens: childParsed.sessionTotals.totalInputTokens,
        outputTokens: childParsed.sessionTotals.outputTokens,
        cacheHitRate: childParsed.sessionTotals.cacheHitRate,
        costUsd: childParsed.cost?.totalCostUsd || 0,
        cacheSavingsUsd: childParsed.cost?.cacheSavingsUsd || 0,
        mtimeMs: childParsed.mtimeMs,
      });
    }

    out.subagents.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    const subTotals = out.subagents.reduce(
      (acc, s) => {
        acc.count += 1;
        acc.activeContextTokens += s.activeContextTokens;
        acc.totalInputTokens += s.totalInputTokens;
        acc.outputTokens += s.outputTokens;
        acc.costUsd += s.costUsd;
        acc.cacheSavingsUsd += s.cacheSavingsUsd;
        return acc;
      },
      {
        count: 0,
        activeContextTokens: 0,
        totalInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        cacheSavingsUsd: 0,
      }
    );
    subTotals.costUsd = roundUsd(subTotals.costUsd);
    subTotals.cacheSavingsUsd = roundUsd(subTotals.cacheSavingsUsd);
    out.subagentsTotals = subTotals;
    out.cost = {
      ...out.cost,
      subagentsCostUsd: subTotals.costUsd,
      totalWithSubagentsUsd: roundUsd((out.cost?.totalCostUsd || 0) + subTotals.costUsd),
    };
  }

  return out;
}

/**
 * List recent conversations sorted by latest transcript modification time.
 */
export function listRecentConversations(opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 30);
  const env = opts.env || process.env;
  const dirs = Array.isArray(opts.dirs) && opts.dirs.length ? opts.dirs : findAppDataDirs(env);

  const candidates = [];
  const seenIds = new Set();

  for (const appData of dirs) {
    const brainRoot = join(appData, 'brain');
    for (const id of safeReaddir(brainRoot)) {
      if (!ID_RE.test(id) || seenIds.has(id)) continue;
      const tPath = transcriptPathFor(appData, id);
      const tStat = safeStat(tPath);
      if (!tStat.exists || tStat.size <= 0) continue;
      seenIds.add(id);
      candidates.push({
        conversationId: id,
        appData,
        product: productOf(appData),
        transcriptPath: tPath,
        mtimeMs: tStat.mtimeMs,
        size: tStat.size,
      });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sliced = candidates.slice(0, limit);

  return sliced.map((c) => {
    const parsed = analyzeTranscriptFile(c.transcriptPath, {
      windowSize: opts.windowSize,
      pricing: opts.pricing,
      env,
      cacheDir: opts.cacheDir,
      disableRemoteRefresh: opts.disableRemoteRefresh,
    });
    return {
      conversationId: c.conversationId,
      product: c.product,
      mtimeMs: c.mtimeMs,
      size: c.size,
      title: parsed?.title || c.conversationId.slice(0, 8),
      model: parsed?.model || '',
      modelLabel: parsed?.modelLabel || 'Unknown',
      isOrchestrator: Boolean(parsed?.modelBreakdown?.isOrchestrator),
      isMultiModel: Boolean(parsed?.modelBreakdown?.isMultiModel),
      switchCount: parsed?.modelBreakdown?.switchCount || 0,
      activeTag: parsed?.modelBreakdown?.activeTag || '',
      lastActivityAt: parsed?.lastActivityAt || '',
      activeContextTokens: parsed?.activeContextTokens || 0,
      contextWindowSize: parsed?.contextWindowSize || DEFAULT_WINDOW_SIZE,
      usedPercentage: parsed?.usedPercentage || 0,
      health: parsed?.health || 'healthy',
      exceeds200k: parsed?.exceeds200k || false,
      invocations: parsed?.sessionTotals?.invocations || 0,
      totalInputTokens: parsed?.sessionTotals?.totalInputTokens || 0,
      outputTokens: parsed?.sessionTotals?.outputTokens || 0,
      cacheHitRate: parsed?.sessionTotals?.cacheHitRate || 0,
      costUsd: parsed?.cost?.totalCostUsd || 0,
      cacheSavingsUsd: parsed?.cost?.cacheSavingsUsd || 0,
    };
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatLocalDateTime(ms) {
  const d = new Date(ms);
  return `${formatLocalDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isLocalDayStart(ms) {
  const d = new Date(ms);
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

function isLocalDayEnd(ms) {
  const d = new Date(ms);
  return d.getHours() === 23 && d.getMinutes() === 59;
}

function formatBoundLabel(ms, { isEnd = false } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return 'Origin';
  if ((!isEnd && isLocalDayStart(ms)) || (isEnd && isLocalDayEnd(ms))) {
    return formatLocalDate(ms);
  }
  return formatLocalDateTime(ms);
}

/**
 * Parse a date/datetime/epoch boundary in local calendar time (unless explicit timezone suffix present).
 */
export function parseTimeBound(input, { isEnd = false } = {}) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null;
    return input < 1e11 ? input * 1000 : input;
  }

  const raw = String(input).trim();
  if (!raw) return null;

  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    return n < 1e11 ? n * 1000 : n;
  }

  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const m = Number(dateOnly[2]);
    const d = Number(dateOnly[3]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d, isEnd ? 23 : 0, isEnd ? 59 : 0, isEnd ? 59 : 0, isEnd ? 999 : 0);
    const ms = dt.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const localDateTime = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(
    raw
  );
  if (localDateTime) {
    const y = Number(localDateTime[1]);
    const m = Number(localDateTime[2]);
    const d = Number(localDateTime[3]);
    const hh = Number(localDateTime[4]);
    const mm = Number(localDateTime[5]);
    const ss = localDateTime[6] !== undefined ? Number(localDateTime[6]) : isEnd ? 59 : 0;
    const msPart = isEnd ? 999 : 0;
    if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
    const dt = new Date(y, m - 1, d, hh, mm, ss, msPart);
    const ms = dt.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve day / week / month / all / custom range bounds in local calendar time.
 */
export function resolveStatsTimeRange({ period = 'week', from = '', to = '', nowMs = Date.now() } = {}) {
  const fromRaw = typeof from === 'string' || typeof from === 'number' ? String(from).trim() : '';
  const toRaw = typeof to === 'string' || typeof to === 'number' ? String(to).trim() : '';

  let normalizedPeriod = 'week';
  const pRaw = String(period || 'week').trim().toLowerCase();
  if (fromRaw || toRaw || pRaw === 'custom') {
    normalizedPeriod = 'custom';
  } else if (pRaw === 'day' || pRaw === 'today' || pRaw === '1d' || pRaw === 'daily') {
    normalizedPeriod = 'day';
  } else if (pRaw === 'week' || pRaw === '7d' || pRaw === 'weekly') {
    normalizedPeriod = 'week';
  } else if (pRaw === 'month' || pRaw === '30d' || pRaw === 'monthly') {
    normalizedPeriod = 'month';
  } else if (pRaw === 'all' || pRaw === 'total') {
    normalizedPeriod = 'all';
  }

  const now = new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const endOfToday = new Date(y, m, d, 23, 59, 59, 999).getTime();

  let fromMs = 0;
  let toMs = endOfToday;
  let periodLabel = 'Last 7 Days';
  let granularity = 'day';

  if (normalizedPeriod === 'day') {
    fromMs = new Date(y, m, d, 0, 0, 0, 0).getTime();
    toMs = endOfToday;
    periodLabel = 'Today';
    granularity = 'hour';
  } else if (normalizedPeriod === 'week') {
    fromMs = new Date(y, m, d - 6, 0, 0, 0, 0).getTime();
    toMs = endOfToday;
    periodLabel = 'Last 7 Days';
    granularity = 'day';
  } else if (normalizedPeriod === 'month') {
    fromMs = new Date(y, m, d - 29, 0, 0, 0, 0).getTime();
    toMs = endOfToday;
    periodLabel = 'Last 30 Days';
    granularity = 'day';
  } else if (normalizedPeriod === 'all') {
    fromMs = 0;
    toMs = endOfToday;
    periodLabel = 'All Time';
    granularity = 'auto';
  } else {
    const parsedFrom = parseTimeBound(fromRaw, { isEnd: false });
    const parsedTo = parseTimeBound(toRaw, { isEnd: true });
    fromMs = parsedFrom !== null ? parsedFrom : 0;
    toMs = parsedTo !== null ? parsedTo : endOfToday;
    if (fromMs > 0 && toMs > 0 && fromMs > toMs) {
      [fromMs, toMs] = [toMs, fromMs];
    }
    periodLabel = 'Custom Range';
    granularity = 'auto';
  }

  return {
    period: normalizedPeriod,
    periodLabel,
    granularity,
    fromMs,
    toMs,
    fromIso: fromMs > 0 ? new Date(fromMs).toISOString() : '',
    toIso: toMs > 0 ? new Date(toMs).toISOString() : '',
    fromLabel: formatBoundLabel(fromMs, { isEnd: false }),
    toLabel: formatBoundLabel(toMs, { isEnd: true }),
  };
}

function chooseBucketGranularity(requested, fromMs, toMs) {
  const spanMs = Math.max(1, toMs - fromMs);
  let gran = requested;
  if (!gran || gran === 'auto') {
    if (spanMs <= 48 * 3_600_000) gran = 'hour';
    else if (spanMs <= 62 * 86_400_000) gran = 'day';
    else if (spanMs <= 270 * 86_400_000) gran = 'week';
    else gran = 'month';
  }
  if (gran === 'hour' && spanMs / 3_600_000 > 120) gran = 'day';
  if (gran === 'day' && spanMs / 86_400_000 > 120) gran = 'week';
  if (gran === 'week' && spanMs / (7 * 86_400_000) > 120) gran = 'month';
  return gran;
}

function bucketInfoForTimestamp(ts, gran) {
  const dt = new Date(ts);
  const y = dt.getFullYear();
  const m = dt.getMonth();
  const d = dt.getDate();

  if (gran === 'hour') {
    const hh = dt.getHours();
    const startMs = new Date(y, m, d, hh, 0, 0, 0).getTime();
    const endMs = new Date(y, m, d, hh, 59, 59, 999).getTime();
    const key = `${formatLocalDate(startMs)}T${pad2(hh)}`;
    const label = `${pad2(hh)}:00`;
    const nextCursorMs = new Date(y, m, d, hh + 1, 0, 0, 0).getTime();
    return { key, label, startMs, endMs, nextCursorMs };
  }

  if (gran === 'day') {
    const startMs = new Date(y, m, d, 0, 0, 0, 0).getTime();
    const endMs = new Date(y, m, d, 23, 59, 59, 999).getTime();
    const key = formatLocalDate(startMs);
    const label = `${pad2(m + 1)}-${pad2(d)}`;
    const nextCursorMs = new Date(y, m, d + 1, 0, 0, 0, 0).getTime();
    return { key, label, startMs, endMs, nextCursorMs };
  }

  if (gran === 'week') {
    const dayOfWeek = dt.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const startDt = new Date(y, m, d + mondayOffset, 0, 0, 0, 0);
    const startMs = startDt.getTime();
    const endMs = new Date(
      startDt.getFullYear(),
      startDt.getMonth(),
      startDt.getDate() + 6,
      23,
      59,
      59,
      999
    ).getTime();
    const key = formatLocalDate(startMs);
    const label = `${pad2(startDt.getMonth() + 1)}-${pad2(startDt.getDate())}`;
    const nextCursorMs = new Date(
      startDt.getFullYear(),
      startDt.getMonth(),
      startDt.getDate() + 7,
      0,
      0,
      0,
      0
    ).getTime();
    return { key, label, startMs, endMs, nextCursorMs };
  }

  const startMs = new Date(y, m, 1, 0, 0, 0, 0).getTime();
  const endMs = new Date(y, m + 1, 0, 23, 59, 59, 999).getTime();
  const key = `${y}-${pad2(m + 1)}`;
  const nextCursorMs = new Date(y, m + 1, 1, 0, 0, 0, 0).getTime();
  return { key, label: key, startMs, endMs, nextCursorMs };
}

function makeEmptyBucket(info) {
  return {
    key: info.key,
    label: info.label,
    startMs: info.startMs,
    endMs: info.endMs,
    turnsCount: 0,
    sessionsCount: 0,
    uncachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
    _sessions: new Set(),
  };
}

/**
 * Aggregate token usage, prompt-cache efficiency, and estimated USD cost across sessions in a time window.
 */
export function aggregateUsageStats(opts = {}) {
  const env = opts.env || process.env;
  const dirs = Array.isArray(opts.dirs) && opts.dirs.length ? opts.dirs : findAppDataDirs(env);
  const surfaceRaw = String(opts.surface || 'all').trim().toLowerCase();
  const surfaceFilter = ['app', 'cli', 'ide'].includes(surfaceRaw) ? surfaceRaw : 'all';
  const topLimit = Math.max(1, Number(opts.topLimit) || 15);
  const hasExplicitNow = opts.nowMs !== undefined && opts.nowMs !== null;

  const range = resolveStatsTimeRange({
    period: opts.period || 'week',
    from: opts.from,
    to: opts.to,
    nowMs: hasExplicitNow ? opts.nowMs : Date.now(),
  });

  const candidates = [];
  const seenIds = new Set();
  for (const appData of dirs) {
    const brainRoot = join(appData, 'brain');
    for (const id of safeReaddir(brainRoot)) {
      if (!ID_RE.test(id) || seenIds.has(id)) continue;
      const tPath = transcriptPathFor(appData, id);
      const tStat = safeStat(tPath);
      if (!tStat.exists || tStat.size <= 0) continue;
      seenIds.add(id);
      const product = productOf(appData);
      if (surfaceFilter !== 'all' && product !== surfaceFilter) continue;
      candidates.push({
        conversationId: id,
        appData,
        product,
        transcriptPath: tPath,
        mtimeMs: tStat.mtimeMs,
        size: tStat.size,
      });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const matchedTurns = [];
  const sessionMap = new Map();
  const modelMap = new Map();
  const surfaceMap = new Map();
  let minMatchedTs = 0;
  let maxMatchedTs = 0;
  let sawCustomPricing = false;
  let sawRemotePricing = false;
  let totalUncachedEqCostUsd = 0;

  const totals = {
    sessionsCount: 0,
    turnsCount: 0,
    uncachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0,
    costUsd: 0,
    inputCostUsd: 0,
    cacheReadCostUsd: 0,
    outputCostUsd: 0,
    cacheSavingsUsd: 0,
    cacheSavingsPercentage: 0,
    avgDailyCostUsd: 0,
  };

  for (const c of candidates) {
    // Only fast-skip clearly ancient files when scanning large repositories and fromMs is bounded.
    if (
      candidates.length > 200 &&
      !hasExplicitNow &&
      range.fromMs > 0 &&
      range.fromMs <= Date.now() &&
      c.mtimeMs + 86_400_000 < range.fromMs
    ) {
      continue;
    }

    const parsed = analyzeTranscriptFile(c.transcriptPath, {
      windowSize: opts.windowSize,
      pricing: opts.pricing,
      env,
      cacheDir: opts.cacheDir,
      disableRemoteRefresh: opts.disableRemoteRefresh,
    });
    if (!parsed || !Array.isArray(parsed.turns) || parsed.turns.length === 0) continue;

    const fallbackActivityMs = Date.parse(parsed.lastActivityAt || '');
    const sessionFallbackTs =
      Number.isFinite(fallbackActivityMs) && fallbackActivityMs > 0 ? fallbackActivityMs : c.mtimeMs;

    for (const turn of parsed.turns) {
      const turnCreatedMs = Date.parse(turn.createdAt || '');
      const ts = Number.isFinite(turnCreatedMs) && turnCreatedMs > 0 ? turnCreatedMs : sessionFallbackTs;
      if (range.fromMs > 0 && ts < range.fromMs) continue;
      if (range.toMs > 0 && ts > range.toMs) continue;

      if (minMatchedTs === 0 || ts < minMatchedTs) minMatchedTs = ts;
      if (ts > maxMatchedTs) maxMatchedTs = ts;

      if (parsed.cost?.pricingSource === 'custom') sawCustomPricing = true;
      else if (parsed.cost?.pricingSource === 'remote-cache') sawRemotePricing = true;

      const uncached = Number(turn.inputTokens) || 0;
      const cacheWrite = Number(turn.cacheCreationTokens) || 0;
      const cacheRead = Number(turn.cacheReadTokens) || 0;
      const promptTokens = Number(turn.promptTokens) || uncached + cacheRead;
      const outputTokens = Number(turn.outputTokens) || 0;
      const turnTotalTokens = promptTokens + outputTokens;

      const costUsd = Number(turn.costUsd) || 0;
      const inputCostUsd = Number(turn.inputCostUsd) || 0;
      const cacheReadCostUsd = Number(turn.cacheReadCostUsd) || 0;
      const outputCostUsd = Number(turn.outputCostUsd) || 0;
      const cacheSavingsUsd = Number(turn.cacheSavingsUsd) || 0;
      const uncachedEq = costUsd + cacheSavingsUsd;

      totals.turnsCount += 1;
      totals.uncachedInputTokens += uncached;
      totals.cacheCreationTokens += cacheWrite;
      totals.cacheReadTokens += cacheRead;
      totals.totalInputTokens += promptTokens;
      totals.outputTokens += outputTokens;
      totals.totalTokens += turnTotalTokens;
      totals.costUsd += costUsd;
      totals.inputCostUsd += inputCostUsd;
      totals.cacheReadCostUsd += cacheReadCostUsd;
      totals.outputCostUsd += outputCostUsd;
      totals.cacheSavingsUsd += cacheSavingsUsd;
      totalUncachedEqCostUsd += uncachedEq;

      matchedTurns.push({
        ts,
        conversationId: c.conversationId,
        uncached,
        cacheWrite,
        cacheRead,
        promptTokens,
        outputTokens,
        totalTokens: turnTotalTokens,
        costUsd,
        cacheSavingsUsd,
      });

      let sess = sessionMap.get(c.conversationId);
      if (!sess) {
        sess = {
          conversationId: c.conversationId,
          product: c.product,
          title: parsed.title || c.conversationId.slice(0, 8),
          model: parsed.modelLabel || parsed.model || 'Unknown',
          turnsCount: 0,
          totalInputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          cacheSavingsUsd: 0,
          lastTurnMs: ts,
        };
        sessionMap.set(c.conversationId, sess);
      }
      sess.turnsCount += 1;
      sess.totalInputTokens += promptTokens;
      sess.cacheReadTokens += cacheRead;
      sess.outputTokens += outputTokens;
      sess.totalTokens += turnTotalTokens;
      sess.costUsd += costUsd;
      sess.cacheSavingsUsd += cacheSavingsUsd;
      if (ts >= sess.lastTurnMs) sess.lastTurnMs = ts;

      const modelKey =
        String(turn.rawModel || turn.model || parsed.model || parsed.modelLabel || 'unknown').trim() ||
        'unknown';
      let mEntry = modelMap.get(modelKey);
      if (!mEntry) {
        mEntry = {
          model: modelKey,
          pricingModel: turn.pricingModel || modelKey,
          invocations: 0,
          uncachedInputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          inputCostUsd: 0,
          cacheReadCostUsd: 0,
          outputCostUsd: 0,
          cacheSavingsUsd: 0,
        };
        modelMap.set(modelKey, mEntry);
      }
      mEntry.invocations += 1;
      mEntry.uncachedInputTokens += uncached;
      mEntry.cacheCreationTokens += cacheWrite;
      mEntry.cacheReadTokens += cacheRead;
      mEntry.totalInputTokens += promptTokens;
      mEntry.outputTokens += outputTokens;
      mEntry.totalTokens += turnTotalTokens;
      mEntry.costUsd += costUsd;
      mEntry.inputCostUsd += inputCostUsd;
      mEntry.cacheReadCostUsd += cacheReadCostUsd;
      mEntry.outputCostUsd += outputCostUsd;
      mEntry.cacheSavingsUsd += cacheSavingsUsd;

      let sEntry = surfaceMap.get(c.product);
      if (!sEntry) {
        sEntry = {
          surface: c.product,
          _sessions: new Set(),
          sessionsCount: 0,
          turnsCount: 0,
          totalTokens: 0,
          costUsd: 0,
          cacheSavingsUsd: 0,
        };
        surfaceMap.set(c.product, sEntry);
      }
      sEntry._sessions.add(c.conversationId);
      sEntry.turnsCount += 1;
      sEntry.totalTokens += turnTotalTokens;
      sEntry.costUsd += costUsd;
      sEntry.cacheSavingsUsd += cacheSavingsUsd;
    }
  }

  const effectiveFromMs = range.fromMs > 0 ? range.fromMs : minMatchedTs;
  const effectiveToMs = range.toMs > 0 ? range.toMs : maxMatchedTs;
  const spanDays =
    effectiveFromMs > 0 && effectiveToMs >= effectiveFromMs
      ? Math.max(1, Math.round((effectiveToMs - effectiveFromMs + 1) / 86_400_000))
      : 1;

  totals.sessionsCount = sessionMap.size;
  totals.cacheHitRate =
    totals.totalInputTokens > 0
      ? Number(((totals.cacheReadTokens / totals.totalInputTokens) * 100).toFixed(1))
      : 0;
  totals.costUsd = roundUsd(totals.costUsd);
  totals.inputCostUsd = roundUsd(totals.inputCostUsd);
  totals.cacheReadCostUsd = roundUsd(totals.cacheReadCostUsd);
  totals.outputCostUsd = roundUsd(totals.outputCostUsd);
  totals.cacheSavingsUsd = roundUsd(totals.cacheSavingsUsd);
  totals.cacheSavingsPercentage =
    totalUncachedEqCostUsd > 0
      ? Number(((totals.cacheSavingsUsd / totalUncachedEqCostUsd) * 100).toFixed(1))
      : 0;
  totals.avgDailyCostUsd = roundUsd(totals.costUsd / spanDays);

  const chartFromMs = range.fromMs > 0 ? range.fromMs : minMatchedTs;
  const chartToMs = range.toMs > 0 ? range.toMs : maxMatchedTs;
  const finalGranularity =
    chartFromMs > 0 && chartToMs >= chartFromMs
      ? chooseBucketGranularity(range.granularity, chartFromMs, chartToMs)
      : range.granularity === 'auto'
        ? 'day'
        : range.granularity;

  const bucketMap = new Map();
  if (chartFromMs > 0 && chartToMs >= chartFromMs && (range.fromMs > 0 || matchedTurns.length > 0)) {
    let cursor = bucketInfoForTimestamp(chartFromMs, finalGranularity).startMs;
    let safety = 0;
    while (cursor <= chartToMs && safety < 240) {
      const info = bucketInfoForTimestamp(cursor, finalGranularity);
      if (!bucketMap.has(info.key)) {
        bucketMap.set(info.key, makeEmptyBucket(info));
      }
      if (info.nextCursorMs <= cursor) break;
      cursor = info.nextCursorMs;
      safety += 1;
    }
  }

  for (const mt of matchedTurns) {
    const info = bucketInfoForTimestamp(mt.ts, finalGranularity);
    let b = bucketMap.get(info.key);
    if (!b) {
      b = makeEmptyBucket(info);
      bucketMap.set(info.key, b);
    }
    b.turnsCount += 1;
    b._sessions.add(mt.conversationId);
    b.uncachedInputTokens += mt.uncached;
    b.cacheCreationTokens += mt.cacheWrite;
    b.cacheReadTokens += mt.cacheRead;
    b.totalInputTokens += mt.promptTokens;
    b.outputTokens += mt.outputTokens;
    b.totalTokens += mt.totalTokens;
    b.costUsd += mt.costUsd;
    b.cacheSavingsUsd += mt.cacheSavingsUsd;
  }

  const buckets = [...bucketMap.values()]
    .sort((a, b) => a.startMs - b.startMs)
    .map(({ _sessions, ...b }) => ({
      ...b,
      sessionsCount: _sessions.size,
      costUsd: roundUsd(b.costUsd),
      cacheSavingsUsd: roundUsd(b.cacheSavingsUsd),
    }));

  const byModel = [...modelMap.values()]
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens)
    .map((m) => ({
      ...m,
      costUsd: roundUsd(m.costUsd),
      inputCostUsd: roundUsd(m.inputCostUsd),
      cacheReadCostUsd: roundUsd(m.cacheReadCostUsd),
      outputCostUsd: roundUsd(m.outputCostUsd),
      cacheSavingsUsd: roundUsd(m.cacheSavingsUsd),
      cacheHitRate:
        m.totalInputTokens > 0 ? Number(((m.cacheReadTokens / m.totalInputTokens) * 100).toFixed(1)) : 0,
      costSharePercentage:
        totals.costUsd > 0 ? Number(((m.costUsd / totals.costUsd) * 100).toFixed(1)) : 0,
    }));

  const bySurface = [...surfaceMap.values()]
    .map(({ _sessions, ...s }) => ({
      ...s,
      sessionsCount: _sessions.size,
      costUsd: roundUsd(s.costUsd),
      cacheSavingsUsd: roundUsd(s.cacheSavingsUsd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const topSessions = [...sessionMap.values()]
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens)
    .slice(0, topLimit)
    .map((s) => ({
      conversationId: s.conversationId,
      product: s.product,
      title: s.title,
      model: s.model,
      turnsCount: s.turnsCount,
      totalInputTokens: s.totalInputTokens,
      cacheReadTokens: s.cacheReadTokens,
      outputTokens: s.outputTokens,
      totalTokens: s.totalTokens,
      costUsd: roundUsd(s.costUsd),
      cacheSavingsUsd: roundUsd(s.cacheSavingsUsd),
      lastTurnAt: new Date(s.lastTurnMs).toISOString(),
    }));

  const remoteCache = loadRemotePricingCache({
    env,
    cacheDir: opts.cacheDir,
    disableRemoteRefresh: true,
  });

  return {
    period: range.period,
    periodLabel: range.periodLabel,
    granularity: finalGranularity,
    surfaceFilter,
    range: {
      fromMs: effectiveFromMs,
      toMs: effectiveToMs,
      fromIso: effectiveFromMs > 0 ? new Date(effectiveFromMs).toISOString() : '',
      toIso: effectiveToMs > 0 ? new Date(effectiveToMs).toISOString() : '',
      fromLabel: effectiveFromMs > 0 ? formatBoundLabel(effectiveFromMs, { isEnd: false }) : 'Origin',
      toLabel: formatBoundLabel(effectiveToMs, { isEnd: true }),
      spanDays,
    },
    totals,
    buckets,
    byModel,
    bySurface,
    topSessions,
    pricingSource: sawCustomPricing ? 'custom' : sawRemotePricing ? 'remote-cache' : 'builtin',
    pricingCache: remoteCache
      ? {
          sourceUrl: remoteCache.sourceUrl,
          fetchedAt: remoteCache.fetchedAt,
          downloadedAt: remoteCache.downloadedAt,
          checkedAt: remoteCache.checkedAt,
          lastModified: remoteCache.lastModified,
          expiresAt: remoteCache.expiresAt,
          stale: remoteCache.stale,
          modelCount: remoteCache.modelCount,
        }
      : null,
  };
}
