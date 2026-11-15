import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REMOTE_PRICING_URL =
  'https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json';
export const WEEKLY_PRICING_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ONE_MILLION = 1_000_000;
const SELF_FILE_PATH = fileURLToPath(import.meta.url);
const CACHE_FILENAME = 'ratio-config-cache.json';
const LOCK_FILENAME = 'ratio-config-cache.lock.json';
const REFRESH_LOCK_COOLDOWN_MS = 60_000;

const pricingFileCache = new Map(); // path -> { key, map }
const remoteCacheFileMap = new Map(); // path -> { key, data }

/**
 * Built-in LLM pricing profiles in USD per 1M tokens, ordered from most specific to most general.
 */
export const DEFAULT_PRICING_PROFILES = [
  {
    pricingId: 'gemini-4-hydrogen',
    patterns: ['hydrogen'],
    in: 4.0,
    out: 20.0,
    cacheRead: 0.4,
    cacheWrite: 4.0,
    longContextThreshold: 200_000,
    longContext: { in: 8.0, out: 30.0, cacheRead: 0.8, cacheWrite: 8.0 },
  },
  {
    pricingId: 'gemini-4-argon',
    patterns: ['argon', 'orchestrator-argon', 'orchestrator (argon)'],
    in: 2.5,
    out: 15.0,
    cacheRead: 0.25,
    cacheWrite: 2.5,
    longContextThreshold: 200_000,
    longContext: { in: 5.0, out: 22.5, cacheRead: 0.5, cacheWrite: 5.0 },
  },
  {
    pricingId: 'gemini-4-carbon',
    patterns: ['carbon', 'gemini-pro-orchestrator', 'orchestrator', 'gemini-3-pro', 'gemini-3.1-pro'],
    in: 2.0,
    out: 12.0,
    cacheRead: 0.2,
    cacheWrite: 2.0,
    longContextThreshold: 200_000,
    longContext: { in: 4.0, out: 18.0, cacheRead: 0.4, cacheWrite: 4.0 },
  },
  {
    pricingId: 'gemini-3.8-flash',
    patterns: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3-flash', 'gemini-flash-worker'],
    in: 0.75,
    out: 3.75,
    cacheRead: 0.075,
    cacheWrite: 0.75,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gemini-3.5-flash',
    patterns: ['gemini-3.5-flash'],
    in: 1.5,
    out: 9.0,
    cacheRead: 0.15,
    cacheWrite: 1.5,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gemini-2.5-flash-lite',
    patterns: ['flash-lite'],
    in: 0.1,
    out: 0.4,
    cacheRead: 0.025,
    cacheWrite: 0.1,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gemini-2.5-flash',
    patterns: ['gemini-2.5-flash', 'gemini-flash', 'flash', 'worker', 'executor'],
    in: 0.3,
    out: 2.5,
    cacheRead: 0.03,
    cacheWrite: 0.3,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gemini-2.5-pro',
    patterns: ['gemini-2.5-pro', 'gemini-pro', 'gemini'],
    in: 1.25,
    out: 10.0,
    cacheRead: 0.31,
    cacheWrite: 1.25,
    longContextThreshold: 200_000,
    longContext: { in: 2.5, out: 15.0, cacheRead: 0.625, cacheWrite: 2.5 },
  },
  {
    pricingId: 'claude-opus-5-5',
    patterns: ['claude-opus-5', 'opus 5'],
    in: 4.0,
    out: 20.0,
    cacheRead: 0.2,
    cacheWrite: 5.0,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'claude-opus-4-5',
    patterns: ['claude-opus-4-5', 'claude-opus-4-6', 'opus 4.5', 'opus 4.6'],
    in: 5.0,
    out: 25.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'claude-opus-4',
    patterns: ['claude-opus', 'claude-3-opus', 'opus'],
    in: 15.0,
    out: 75.0,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'claude-sonnet-5-5',
    patterns: ['claude-sonnet-5', 'sonnet 5'],
    in: 2.0,
    out: 10.0,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'claude-haiku',
    patterns: ['haiku'],
    in: 1.0,
    out: 5.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'claude-sonnet-4',
    patterns: ['claude-sonnet', 'claude-3-7', 'claude-3-5', 'sonnet', 'claude'],
    in: 3.0,
    out: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    longContextThreshold: 200_000,
    longContext: { in: 6.0, out: 22.5, cacheRead: 0.6, cacheWrite: 7.5 },
  },
  {
    pricingId: 'gpt-oss-120b',
    patterns: ['gpt-oss'],
    in: 0.15,
    out: 0.6,
    cacheRead: 0.075,
    cacheWrite: 0.15,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gpt-4.1-nano',
    patterns: ['gpt-4.1-nano'],
    in: 0.1,
    out: 0.4,
    cacheRead: 0.025,
    cacheWrite: 0.1,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gpt-4.1-mini',
    patterns: ['gpt-4.1-mini'],
    in: 0.4,
    out: 1.6,
    cacheRead: 0.1,
    cacheWrite: 0.4,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gpt-4.1',
    patterns: ['gpt-4.1'],
    in: 2.0,
    out: 8.0,
    cacheRead: 0.5,
    cacheWrite: 2.0,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gpt-4o-mini',
    patterns: ['gpt-4o-mini'],
    in: 0.15,
    out: 0.6,
    cacheRead: 0.075,
    cacheWrite: 0.15,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'gpt-4o',
    patterns: ['gpt-4o'],
    in: 2.5,
    out: 10.0,
    cacheRead: 1.25,
    cacheWrite: 2.5,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'o3-mini',
    patterns: ['o3-mini', 'o4-mini'],
    in: 1.1,
    out: 4.4,
    cacheRead: 0.275,
    cacheWrite: 1.1,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'o3',
    patterns: [/\bo3(?:\b|-)/],
    in: 2.0,
    out: 8.0,
    cacheRead: 0.5,
    cacheWrite: 2.0,
    longContextThreshold: 0,
    longContext: null,
  },
  {
    pricingId: 'o1',
    patterns: [/\bo1(?:\b|-)/],
    in: 15.0,
    out: 60.0,
    cacheRead: 7.5,
    cacheWrite: 15.0,
    longContextThreshold: 0,
    longContext: null,
  },
];

export const FALLBACK_PRICING_PROFILE = {
  pricingId: 'default-pro',
  in: 2.0,
  out: 12.0,
  cacheRead: 0.2,
  cacheWrite: 2.0,
  longContextThreshold: 200_000,
  longContext: { in: 4.0, out: 18.0, cacheRead: 0.4, cacheWrite: 4.0 },
  isFallback: true,
  pricingSource: 'fallback',
};

const WORKER_FALLBACK_PROFILE =
  DEFAULT_PRICING_PROFILES.find((p) => p.pricingId === 'gemini-3.8-flash') || FALLBACK_PRICING_PROFILE;

function roundUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e8) / 1e8;
}

function nonNegNum(val, fallback = undefined) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
    return fallback;
  }
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeOverrideEntry(key, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inRate = nonNegNum(raw.in ?? raw.input ?? raw.inputPerMillion);
  const outRate = nonNegNum(raw.out ?? raw.output ?? raw.outputPerMillion);
  if (inRate === undefined && outRate === undefined) return null;

  const finalIn = inRate ?? 0;
  const finalOut = outRate ?? 0;
  const cacheRead = nonNegNum(
    raw.cacheRead ?? raw.cache_read ?? raw.cachedInput ?? raw.cacheReadPerMillion,
    finalIn * 0.1
  );
  const cacheWrite = nonNegNum(
    raw.cacheWrite ?? raw.cache_write ?? raw.cacheCreation ?? raw.cacheWritePerMillion,
    finalIn
  );

  const rawLong = raw.longContext || raw.long_context;
  let longContext = null;
  let longContextThreshold = nonNegNum(raw.longContextThreshold ?? raw.long_context_threshold, 0);
  if (rawLong && typeof rawLong === 'object') {
    const lIn = nonNegNum(rawLong.in ?? rawLong.input, finalIn);
    const lOut = nonNegNum(rawLong.out ?? rawLong.output, finalOut);
    longContext = {
      in: lIn,
      out: lOut,
      cacheRead: nonNegNum(rawLong.cacheRead ?? rawLong.cache_read, lIn * 0.1),
      cacheWrite: nonNegNum(rawLong.cacheWrite ?? rawLong.cache_write, lIn),
    };
    if (longContextThreshold <= 0) longContextThreshold = 200_000;
  }

  return {
    pricingId: String(raw.pricingId || key),
    in: finalIn,
    out: finalOut,
    cacheRead,
    cacheWrite,
    longContextThreshold,
    longContext,
    isFallback: false,
    isCustom: true,
    pricingSource: 'custom',
  };
}

function collectOverrides(target, sourceObj) {
  if (!sourceObj || typeof sourceObj !== 'object' || Array.isArray(sourceObj)) return;
  const entries =
    sourceObj.models && typeof sourceObj.models === 'object' && !Array.isArray(sourceObj.models)
      ? sourceObj.models
      : sourceObj;
  for (const [k, v] of Object.entries(entries)) {
    const cleanKey = String(k || '').trim();
    if (!cleanKey) continue;
    const norm = normalizeOverrideEntry(cleanKey, v);
    if (norm) target[cleanKey] = norm;
  }
}

function readOverrideFile(filePath) {
  if (!filePath) return null;
  let st;
  try {
    st = statSync(filePath);
    if (!st.isFile() || st.size < 0) return null;
  } catch {
    return null;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = pricingFileCache.get(filePath);
  if (hit && hit.key === stamp) return hit.map;

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const map = {};
    collectOverrides(map, parsed);
    pricingFileCache.set(filePath, { key: stamp, map });
    if (pricingFileCache.size > 32) {
      const oldest = pricingFileCache.keys().next().value;
      pricingFileCache.delete(oldest);
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Load optional custom model pricing overrides from options, environment JSON, or pricing.json.
 */
export function loadCustomPricingOverrides(opts = {}) {
  const env = opts?.env || process.env;
  const merged = {};

  const filePath =
    (typeof env?.AGY_CTX_PRICING_FILE === 'string' && env.AGY_CTX_PRICING_FILE.trim()) ||
    (typeof env?.PLUGIN_DATA === 'string' && env.PLUGIN_DATA.trim()
      ? join(env.PLUGIN_DATA.trim(), 'pricing.json')
      : '');
  if (filePath) {
    const fromFile = readOverrideFile(filePath);
    if (fromFile) Object.assign(merged, fromFile);
  }

  if (typeof env?.AGY_CTX_PRICING_JSON === 'string' && env.AGY_CTX_PRICING_JSON.trim()) {
    try {
      collectOverrides(merged, JSON.parse(env.AGY_CTX_PRICING_JSON));
    } catch {
      // Ignore invalid inline pricing JSON safely.
    }
  }

  if (opts?.pricing && typeof opts.pricing === 'object') {
    collectOverrides(merged, opts.pricing);
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

const BUILTIN_EXACT_MAP = new Map(DEFAULT_PRICING_PROFILES.map((p) => [p.pricingId.toLowerCase(), p]));

/**
 * Resolve the shared filesystem cache directory across CLI, Hooks, statusLine, and Sidecar.
 */
export function getPricingCacheDir(env = process.env) {
  const override = typeof env?.AGY_CTX_CACHE_DIR === 'string' ? env.AGY_CTX_CACHE_DIR.trim() : '';
  if (override) return resolve(override);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return join(tmpdir(), `antigravity-context-usage-${uid}`);
}

/**
 * Return the full path to the cached weekly NewAPI ratio pricing file.
 */
export function getPricingCacheFilePath(env = process.env, cacheDir = '') {
  return join(cacheDir ? resolve(cacheDir) : getPricingCacheDir(env), CACHE_FILENAME);
}

function isRemotePricingDisabled(opts = {}) {
  const env = opts?.env || process.env;
  if (opts?.disableRemotePricing === true) return true;
  if (env?.AGY_CTX_NO_REMOTE_PRICING === '1' || env?.AGY_CTX_NO_REMOTE_PRICING === 'true') {
    return true;
  }
  const hasExplicitCacheDir = Boolean(
    opts?.cacheDir || (typeof env?.AGY_CTX_CACHE_DIR === 'string' && env.AGY_CTX_CACHE_DIR.trim())
  );
  if (process.env.NODE_TEST_CONTEXT && !hasExplicitCacheDir) {
    return true;
  }
  return false;
}

function resolvePricingTtlMs(env = process.env) {
  const raw = nonNegNum(env?.AGY_CTX_PRICING_TTL_MS);
  return raw !== undefined && raw > 0 ? raw : WEEKLY_PRICING_CACHE_TTL_MS;
}

function resolveRemotePricingUrl(env = process.env) {
  const custom = typeof env?.AGY_CTX_PRICING_URL === 'string' ? env.AGY_CTX_PRICING_URL.trim() : '';
  return custom || DEFAULT_REMOTE_PRICING_URL;
}

function buildLowerRatioMap(obj) {
  const map = Object.create(null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return map;
  for (const [k, v] of Object.entries(obj)) {
    const clean = String(k || '').trim().toLowerCase();
    if (clean) map[clean] = v;
  }
  return map;
}

function lookupRatio(rawMap, lowerMap, rawKey, cleanKey) {
  if (rawMap && Object.prototype.hasOwnProperty.call(rawMap, rawKey)) {
    return rawMap[rawKey];
  }
  return lowerMap[cleanKey];
}

/**
 * Convert a NewAPI ratio_config payload (e.g. basellm ratio_config-v1-base.json) into USD/1M rates.
 */
export function parseNewApiRatioConfig(rawPayload) {
  const body =
    rawPayload?.data && typeof rawPayload.data === 'object' && !Array.isArray(rawPayload.data)
      ? rawPayload.data
      : rawPayload;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { models: {}, modelCount: 0 };
  }

  const models = {};
  if (body.model_ratio && typeof body.model_ratio === 'object' && !Array.isArray(body.model_ratio)) {
    const compRaw =
      body.completion_ratio && typeof body.completion_ratio === 'object' ? body.completion_ratio : {};
    const cacheRaw =
      body.cache_ratio && typeof body.cache_ratio === 'object' ? body.cache_ratio : {};
    const writeRaw =
      body.create_cache_ratio && typeof body.create_cache_ratio === 'object'
        ? body.create_cache_ratio
        : {};
    const compLower = buildLowerRatioMap(compRaw);
    const cacheLower = buildLowerRatioMap(cacheRaw);
    const writeLower = buildLowerRatioMap(writeRaw);

    for (const [rawKey, rawVal] of Object.entries(body.model_ratio)) {
      const cleanKey = String(rawKey || '').trim().toLowerCase();
      if (!cleanKey) continue;
      const ratio = nonNegNum(rawVal);
      if (ratio === undefined) continue;

      const inRate = roundUsd(ratio * 2);
      const compMult = nonNegNum(lookupRatio(compRaw, compLower, rawKey, cleanKey), 1);
      const outRate = roundUsd(inRate * compMult);
      const rawCacheMult = nonNegNum(lookupRatio(cacheRaw, cacheLower, rawKey, cleanKey));
      const rawWriteMult = nonNegNum(lookupRatio(writeRaw, writeLower, rawKey, cleanKey));
      const builtin = BUILTIN_EXACT_MAP.get(cleanKey);

      const cacheRead =
        rawCacheMult !== undefined
          ? roundUsd(inRate * rawCacheMult)
          : builtin && builtin.in > 0
            ? roundUsd(inRate * (builtin.cacheRead / builtin.in))
            : roundUsd(inRate * 0.1);
      const cacheWrite =
        rawWriteMult !== undefined
          ? roundUsd(inRate * rawWriteMult)
          : builtin && builtin.in > 0
            ? roundUsd(inRate * (builtin.cacheWrite / builtin.in))
            : inRate;

      models[cleanKey] = { in: inRate, out: outRate, cacheRead, cacheWrite };
    }
  } else if (body.models && typeof body.models === 'object' && !Array.isArray(body.models)) {
    const normalized = {};
    collectOverrides(normalized, body.models);
    for (const [k, v] of Object.entries(normalized)) {
      models[k.toLowerCase()] = {
        in: roundUsd(v.in),
        out: roundUsd(v.out),
        cacheRead: roundUsd(v.cacheRead),
        cacheWrite: roundUsd(v.cacheWrite),
      };
    }
  }

  return { models, modelCount: Object.keys(models).length };
}

function readJsonQuiet(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Spawn a detached non-blocking worker to refresh stale or missing remote pricing cache.
 */
export function maybeScheduleBackgroundPricingRefresh(opts = {}) {
  const env = opts?.env || process.env;
  if (isRemotePricingDisabled(opts) || opts?.disableRemoteRefresh === true) return false;
  if (process.env.NODE_TEST_CONTEXT && env?.AGY_CTX_ALLOW_BG_REFRESH !== '1') return false;

  const cacheDir = opts?.cacheDir ? resolve(opts.cacheDir) : getPricingCacheDir(env);
  const lockFile = join(cacheDir, LOCK_FILENAME);
  const lock = readJsonQuiet(lockFile);
  if (lock && Number(lock.startedAt) > 0 && Date.now() - Number(lock.startedAt) < REFRESH_LOCK_COOLDOWN_MS) {
    return false;
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
    const child = spawn(process.execPath, [SELF_FILE_PATH, '--sync-remote-pricing'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...env, AGY_CTX_CACHE_DIR: cacheDir },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function parseHttpDateMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function isLastModifiedUnchanged(cachedLM, remoteLM) {
  const cached = String(cachedLM || '').trim();
  const remote = String(remoteLM || '').trim();
  if (!cached || !remote) return false;
  if (cached === remote) return true;
  const cachedMs = parseHttpDateMs(cached);
  const remoteMs = parseHttpDateMs(remote);
  return cachedMs > 0 && remoteMs > 0 && remoteMs <= cachedMs;
}

/**
 * Fetch and atomically persist the weekly NewAPI ratio pricing catalog from the remote endpoint.
 */
export async function syncRemotePricingCache(opts = {}) {
  const env = opts?.env || process.env;
  if (
    (env?.AGY_CTX_NO_REMOTE_PRICING === '1' || env?.AGY_CTX_NO_REMOTE_PRICING === 'true') &&
    !opts?.force &&
    !opts?.forceDownload
  ) {
    return { ok: false, disabled: true };
  }

  const cacheFile = getPricingCacheFilePath(env, opts?.cacheDir);
  const cacheDir = dirname(cacheFile);
  const lockFile = join(cacheDir, LOCK_FILENAME);
  const targetUrl = (opts?.url && String(opts.url).trim()) || resolveRemotePricingUrl(env);
  const ttlMs = resolvePricingTtlMs(env);
  const timeoutMs = Math.max(500, Number(opts?.timeoutMs) || 4500);

  const existing = readJsonQuiet(cacheFile);
  const hasExistingModels = Boolean(
    existing?.models && typeof existing.models === 'object' && Object.keys(existing.models).length > 0
  );
  const existingFetchedAt = Number(existing?.fetchedAt) || 0;
  const existingDownloadedAt = Number(existing?.downloadedAt) || existingFetchedAt;
  const existingCheckedAt = Number(existing?.checkedAt) || existingFetchedAt;
  const existingLastModified = typeof existing?.lastModified === 'string' ? existing.lastModified.trim() : '';
  const forceDownload = Boolean(opts?.forceDownload);
  const forceCheck = Boolean(opts?.force);

  if (
    !forceCheck &&
    !forceDownload &&
    hasExistingModels &&
    existing.sourceUrl === targetUrl &&
    existingFetchedAt > 0 &&
    Date.now() - existingFetchedAt < ttlMs
  ) {
    return {
      ok: true,
      skipped: true,
      fromCache: true,
      cacheFile,
      sourceUrl: existing.sourceUrl,
      fetchedAt: existingFetchedAt,
      downloadedAt: existingDownloadedAt,
      checkedAt: existingCheckedAt,
      lastModified: existingLastModified,
      expiresAt: existingFetchedAt + ttlMs,
      modelCount: existing.modelCount || Object.keys(existing.models).length,
    };
  }

  // Prefer lightweight HEAD check using Last-Modified / If-Modified-Since before downloading JSON.
  if (!forceDownload && hasExistingModels && existing.sourceUrl === targetUrl && existingLastModified) {
    const headHeaders = {
      'If-Modified-Since': existingLastModified,
    };
    if (existing.etag) headHeaders['If-None-Match'] = String(existing.etag);

    try {
      const headRes = await fetch(targetUrl, {
        method: 'HEAD',
        headers: headHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const remoteLM = (headRes.headers.get('last-modified') || '').trim();
      if (headRes.status === 304 || (headRes.ok && isLastModifiedUnchanged(existingLastModified, remoteLM))) {
        const fetchedAt = Date.now();
        const downloadedAt = existingDownloadedAt || fetchedAt;
        const lastModified = remoteLM || existingLastModified;
        const modelCount = existing.modelCount || Object.keys(existing.models).length;
        const renewedPayload = {
          version: 1,
          sourceUrl: targetUrl,
          fetchedAt,
          downloadedAt,
          checkedAt: fetchedAt,
          etag: headRes.headers.get('etag') || existing.etag || '',
          lastModified,
          lastModifiedMs: parseHttpDateMs(lastModified),
          modelCount,
          models: existing.models,
        };
        writeJsonAtomic(cacheFile, renewedPayload);
        rmSync(lockFile, { force: true });
        remoteCacheFileMap.delete(cacheFile);
        return {
          ok: true,
          updated: false,
          notModified: true,
          checkedBy: 'last-modified',
          cacheFile,
          sourceUrl: targetUrl,
          fetchedAt,
          downloadedAt,
          checkedAt: fetchedAt,
          lastModified,
          expiresAt: fetchedAt + ttlMs,
          modelCount,
        };
      }
      // If HEAD returned 405/501/403 or a newer Last-Modified, fall through to GET.
    } catch {
      // Ignore HEAD errors (some proxies disallow HEAD); fall back cleanly to GET.
    }
  }

  const headers = { Accept: 'application/json' };
  if (!forceDownload && hasExistingModels && existing.sourceUrl === targetUrl) {
    if (existing.etag) headers['If-None-Match'] = String(existing.etag);
    if (existingLastModified) headers['If-Modified-Since'] = existingLastModified;
  }

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 304 && hasExistingModels) {
      const fetchedAt = Date.now();
      const downloadedAt = existingDownloadedAt || fetchedAt;
      const lastModified = (res.headers.get('last-modified') || existingLastModified || '').trim();
      const modelCount = existing.modelCount || Object.keys(existing.models).length;
      const updatedPayload = {
        version: 1,
        sourceUrl: targetUrl,
        fetchedAt,
        downloadedAt,
        checkedAt: fetchedAt,
        etag: res.headers.get('etag') || existing.etag || '',
        lastModified,
        lastModifiedMs: parseHttpDateMs(lastModified),
        modelCount,
        models: existing.models,
      };
      writeJsonAtomic(cacheFile, updatedPayload);
      rmSync(lockFile, { force: true });
      remoteCacheFileMap.delete(cacheFile);
      return {
        ok: true,
        updated: false,
        notModified: true,
        checkedBy: lastModified ? 'last-modified' : 'etag',
        cacheFile,
        sourceUrl: targetUrl,
        fetchedAt,
        downloadedAt,
        checkedAt: fetchedAt,
        lastModified,
        expiresAt: fetchedAt + ttlMs,
        modelCount,
      };
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const raw = await res.json();
    const { models, modelCount } = parseNewApiRatioConfig(raw);
    if (modelCount === 0) {
      throw new Error('Remote ratio_config contained 0 valid models');
    }

    const now = Date.now();
    const lastModified = (res.headers.get('last-modified') || '').trim();
    const payload = {
      version: 1,
      sourceUrl: targetUrl,
      fetchedAt: now,
      downloadedAt: now,
      checkedAt: now,
      etag: res.headers.get('etag') || '',
      lastModified,
      lastModifiedMs: parseHttpDateMs(lastModified),
      modelCount,
      models,
    };
    writeJsonAtomic(cacheFile, payload);
    rmSync(lockFile, { force: true });
    remoteCacheFileMap.delete(cacheFile);

    return {
      ok: true,
      updated: true,
      cacheFile,
      sourceUrl: targetUrl,
      fetchedAt: now,
      downloadedAt: now,
      checkedAt: now,
      lastModified,
      expiresAt: now + ttlMs,
      modelCount,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      cacheFile,
      sourceUrl: targetUrl,
      staleFallback: hasExistingModels,
    };
  }
}

/**
 * Synchronously read cached weekly remote pricing from disk, scheduling non-blocking renewal if stale.
 */
export function loadRemotePricingCache(opts = {}) {
  if (isRemotePricingDisabled(opts)) return null;
  const env = opts?.env || process.env;
  const cacheFile = getPricingCacheFilePath(env, opts?.cacheDir);
  const ttlMs = resolvePricingTtlMs(env);

  let st;
  try {
    st = statSync(cacheFile);
    if (!st.isFile() || st.size <= 0) {
      if (!opts?.disableRemoteRefresh) maybeScheduleBackgroundPricingRefresh(opts);
      return null;
    }
  } catch {
    if (!opts?.disableRemoteRefresh) maybeScheduleBackgroundPricingRefresh(opts);
    return null;
  }

  const stamp = `${st.mtimeMs}:${st.size}`;
  let data = remoteCacheFileMap.get(cacheFile)?.key === stamp ? remoteCacheFileMap.get(cacheFile).data : null;

  if (!data) {
    const parsed = readJsonQuiet(cacheFile);
    const models = parsed?.models;
    if (!models || typeof models !== 'object' || Array.isArray(models) || Object.keys(models).length === 0) {
      if (!opts?.disableRemoteRefresh) maybeScheduleBackgroundPricingRefresh(opts);
      return null;
    }
    const fetchedAt = Number(parsed.fetchedAt) || 0;
    data = {
      sourceUrl: parsed.sourceUrl || DEFAULT_REMOTE_PRICING_URL,
      fetchedAt,
      downloadedAt: Number(parsed.downloadedAt) || fetchedAt,
      checkedAt: Number(parsed.checkedAt) || fetchedAt,
      lastModified: typeof parsed.lastModified === 'string' ? parsed.lastModified.trim() : '',
      modelCount: Number(parsed.modelCount) || Object.keys(models).length,
      models,
    };
    remoteCacheFileMap.set(cacheFile, { key: stamp, data });
    if (remoteCacheFileMap.size > 16) {
      const oldest = remoteCacheFileMap.keys().next().value;
      remoteCacheFileMap.delete(oldest);
    }
  }

  const expiresAt = data.fetchedAt + ttlMs;
  const stale = !(data.fetchedAt > 0 && Date.now() < expiresAt);
  if (stale && !opts?.disableRemoteRefresh) {
    maybeScheduleBackgroundPricingRefresh(opts);
  }

  return {
    sourceUrl: data.sourceUrl,
    fetchedAt: data.fetchedAt,
    downloadedAt: data.downloadedAt,
    checkedAt: data.checkedAt,
    lastModified: data.lastModified,
    expiresAt,
    stale,
    modelCount: data.modelCount,
    models: data.models,
  };
}

/**
 * Return a deterministic signature for active pricing rules (custom overrides + cached weekly catalog).
 */
export function getPricingSignature(opts = {}) {
  const parts = [];
  const overrides = loadCustomPricingOverrides(opts);
  if (overrides) {
    const sortedKeys = Object.keys(overrides).sort();
    parts.push(
      sortedKeys
        .map((k) => {
          const p = overrides[k];
          const lc = p.longContext
            ? `@${p.longContextThreshold}:${p.longContext.in},${p.longContext.out},${p.longContext.cacheRead},${p.longContext.cacheWrite}`
            : '';
          return `${k}=${p.in},${p.out},${p.cacheRead},${p.cacheWrite}${lc}`;
        })
        .join('|')
    );
  }

  const remoteCache = loadRemotePricingCache({ ...opts, disableRemoteRefresh: true });
  if (remoteCache) {
    parts.push(
      `rc:${remoteCache.downloadedAt || remoteCache.fetchedAt}:${remoteCache.lastModified || ''}:${remoteCache.modelCount}`
    );
  }

  return parts.length > 0 ? parts.join('||') : 'default';
}

function matchOverrideKey(text, overrides) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle || !overrides) return null;

  const keys = Object.keys(overrides);
  for (const k of keys) {
    if (k.toLowerCase() === needle) return overrides[k];
  }
  const byLength = keys.slice().sort((a, b) => b.length - a.length);
  for (const k of byLength) {
    if (needle.includes(k.toLowerCase())) return overrides[k];
  }
  return null;
}

function matchRemoteCatalogModel(text, remoteModels, { isDisplayLabel = false } = {}) {
  if (!remoteModels || typeof remoteModels !== 'object') return null;
  let clean = String(text || '').trim().toLowerCase();
  if (!clean) return null;

  if (isDisplayLabel) {
    if (/orchestrator|antigravity|unknown|^model$/i.test(clean)) return null;
    clean = clean.replace(/\([^)]*\)/g, ' ').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
    if (!clean) return null;
  }

  const base = clean
    .replace(/^(?:models|google|anthropic|openai|vertex_ai|bedrock|deepseek|xai|meta-llama)\//, '')
    .trim()
    .replace(/\s+/g, '-');
  if (!base) return null;

  const c0 = base;
  const c1 = c0.replace(/-agy$/, '');
  const c2 = c1.replace(/-(?:xhigh|high|medium|low|minimal)$/, '');
  const c3 = c2.replace(/-thinking$/, '');
  const c4 = c3.replace(/-latest$/, '');
  const c5 = c4.replace(/-(?:20\d{6}|20\d{2}-\d{2}-\d{2}|\d{4})$/, '');

  const steps = [];
  for (const cand of [c0, c1, c2, c3, c4, c5]) {
    if (cand && !steps.includes(cand)) steps.push(cand);
  }

  for (const step of steps) {
    const dotToHyphen = step.replace(/(\d)\.(\d)/g, '$1-$2');
    const hyphenToDot = step.replace(/(\d)-(\d)(?=-|$)/g, '$1.$2');
    const probes = [step, dotToHyphen, hyphenToDot, `${step}-latest`, `${step}-0`];
    for (const key of probes) {
      const item = key ? remoteModels[key] : null;
      if (item && typeof item === 'object') {
        return {
          pricingId: key,
          in: Number(item.in) || 0,
          out: Number(item.out) || 0,
          cacheRead: Number(item.cacheRead) || 0,
          cacheWrite: Number(item.cacheWrite ?? item.in) || 0,
          longContextThreshold: 0,
          longContext: null,
          isFallback: false,
          isRemote: true,
          pricingSource: 'remote-cache',
        };
      }
    }
  }
  return null;
}

function matchBuiltinProfile(text) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return null;
  for (const profile of DEFAULT_PRICING_PROFILES) {
    for (const pat of profile.patterns) {
      if (pat instanceof RegExp ? pat.test(needle) : needle.includes(pat)) {
        return {
          pricingId: profile.pricingId,
          in: profile.in,
          out: profile.out,
          cacheRead: profile.cacheRead,
          cacheWrite: profile.cacheWrite,
          longContextThreshold: profile.longContextThreshold || 0,
          longContext: profile.longContext ? { ...profile.longContext } : null,
          isFallback: false,
          pricingSource: 'builtin',
        };
      }
    }
  }
  return null;
}

/**
 * Resolve per-1M-token pricing rates: custom overrides > weekly cached catalog > built-in profiles.
 */
export function resolveModelPricing({
  rawModel = '',
  modelLabel = '',
  role = 'single',
  isOrchestrator = false,
  overrides = null,
  remoteModels = undefined,
  env = process.env,
  cacheDir = '',
  disableRemoteRefresh = true,
} = {}) {
  const cleanRaw = String(rawModel || '').trim();
  const cleanLabel = String(modelLabel || '').trim();

  if (overrides) {
    const byRaw = matchOverrideKey(cleanRaw, overrides);
    if (byRaw) return byRaw;
    if (!cleanRaw && isOrchestrator && role === 'worker') {
      const byRole = matchOverrideKey('worker', overrides) || matchOverrideKey('flash', overrides);
      if (byRole) return byRole;
    }
    const byLabel = matchOverrideKey(cleanLabel, overrides);
    if (byLabel) return byLabel;
  }

  const activeRemote =
    remoteModels !== undefined
      ? remoteModels
      : loadRemotePricingCache({ env, cacheDir, disableRemoteRefresh })?.models || null;

  if (activeRemote) {
    if (cleanRaw) {
      const remoteByRaw = matchRemoteCatalogModel(cleanRaw, activeRemote);
      if (remoteByRaw) return remoteByRaw;
    }
    if (!(!cleanRaw && isOrchestrator && role === 'worker') && cleanLabel) {
      const remoteByLabel = matchRemoteCatalogModel(cleanLabel, activeRemote, { isDisplayLabel: true });
      if (remoteByLabel) return remoteByLabel;
    }
  }

  if (cleanRaw) {
    const byRaw = matchBuiltinProfile(cleanRaw);
    if (byRaw) return byRaw;
  }

  if (!cleanRaw && isOrchestrator && role === 'worker') {
    return {
      pricingId: WORKER_FALLBACK_PROFILE.pricingId,
      in: WORKER_FALLBACK_PROFILE.in,
      out: WORKER_FALLBACK_PROFILE.out,
      cacheRead: WORKER_FALLBACK_PROFILE.cacheRead,
      cacheWrite: WORKER_FALLBACK_PROFILE.cacheWrite,
      longContextThreshold: WORKER_FALLBACK_PROFILE.longContextThreshold || 0,
      longContext: WORKER_FALLBACK_PROFILE.longContext
        ? { ...WORKER_FALLBACK_PROFILE.longContext }
        : null,
      isFallback: false,
      pricingSource: 'builtin',
    };
  }

  if (cleanLabel) {
    const byLabel = matchBuiltinProfile(cleanLabel);
    if (byLabel) return byLabel;
  }

  return {
    ...FALLBACK_PRICING_PROFILE,
    longContext: { ...FALLBACK_PRICING_PROFILE.longContext },
  };
}

/**
 * Calculate exact USD cost breakdown and prompt-cache savings for a single model invocation.
 */
export function calculateTurnCost(
  {
    freshInputTokens = 0,
    cacheCreationTokens = 0,
    cacheReadTokens = 0,
    outputTokens = 0,
    promptTokens = 0,
  } = {},
  pricing = FALLBACK_PRICING_PROFILE
) {
  const fresh = Math.max(0, Number(freshInputTokens) || 0);
  const write = Math.max(0, Number(cacheCreationTokens) || 0);
  const cached = Math.max(0, Number(cacheReadTokens) || 0);
  const out = Math.max(0, Number(outputTokens) || 0);
  const totalPrompt = Math.max(0, Number(promptTokens) || fresh + write + cached);

  const threshold = Number(pricing?.longContextThreshold) || 0;
  const longContextTier = Boolean(threshold > 0 && pricing?.longContext && totalPrompt > threshold);
  const rates = longContextTier ? pricing.longContext : pricing || FALLBACK_PRICING_PROFILE;

  const inRate = Number(rates.in) || 0;
  const writeRate = Number(rates.cacheWrite ?? rates.in) || 0;
  const readRate = Number(rates.cacheRead) || 0;
  const outRate = Number(rates.out) || 0;

  const freshInputCostUsd = (fresh / ONE_MILLION) * inRate;
  const cacheWriteCostUsd = (write / ONE_MILLION) * writeRate;
  const inputCostUsd = freshInputCostUsd + cacheWriteCostUsd;
  const cacheReadCostUsd = (cached / ONE_MILLION) * readRate;
  const outputCostUsd = (out / ONE_MILLION) * outRate;
  const totalCostUsd = inputCostUsd + cacheReadCostUsd + outputCostUsd;

  const uncachedEquivalentCostUsd =
    (totalPrompt / ONE_MILLION) * inRate + (out / ONE_MILLION) * outRate;
  const cacheSavingsUsd = Math.max(0, uncachedEquivalentCostUsd - totalCostUsd);

  return {
    longContextTier,
    freshInputCostUsd: roundUsd(freshInputCostUsd),
    cacheWriteCostUsd: roundUsd(cacheWriteCostUsd),
    inputCostUsd: roundUsd(inputCostUsd),
    cacheReadCostUsd: roundUsd(cacheReadCostUsd),
    outputCostUsd: roundUsd(outputCostUsd),
    totalCostUsd: roundUsd(totalCostUsd),
    uncachedEquivalentCostUsd: roundUsd(uncachedEquivalentCostUsd),
    cacheSavingsUsd: roundUsd(cacheSavingsUsd),
  };
}

/**
 * Estimate session USD cost from a CLI statusLine payload when transcript_path is absent.
 */
export function estimatePayloadCost({
  totalInputTokens = 0,
  totalOutputTokens = 0,
  currentUsage = null,
  exceeds200k = false,
  modelId = '',
  modelLabel = '',
  overrides = null,
  env = process.env,
  cacheDir = '',
  disableRemoteRefresh = true,
} = {}) {
  const totIn = Math.max(0, Number(totalInputTokens) || 0);
  const totOut = Math.max(0, Number(totalOutputTokens) || 0);
  if (totIn <= 0 && totOut <= 0) return 0;

  let cacheRatio = 0;
  let writeRatio = 0;
  if (currentUsage && typeof currentUsage === 'object') {
    const curFresh = Math.max(0, Number(currentUsage.input_tokens) || 0);
    const curRead = Math.max(0, Number(currentUsage.cache_read_input_tokens) || 0);
    const curWrite = Math.max(0, Number(currentUsage.cache_creation_input_tokens) || 0);
    const curSum = curFresh + curRead + curWrite;
    if (curSum > 0) {
      cacheRatio = curRead / curSum;
      writeRatio = curWrite / curSum;
    }
  }

  const cacheReadTokens = Math.round(totIn * cacheRatio);
  const cacheCreationTokens = Math.round(totIn * writeRatio);
  const freshInputTokens = Math.max(0, totIn - cacheReadTokens - cacheCreationTokens);

  const activeOverrides = overrides ?? loadCustomPricingOverrides({ env });
  const pricing = resolveModelPricing({
    rawModel: modelId,
    modelLabel,
    isOrchestrator: /orchestrator/i.test(`${modelId} ${modelLabel}`),
    overrides: activeOverrides,
    env,
    cacheDir,
    disableRemoteRefresh,
  });

  const curPrompt = currentUsage
    ? (Number(currentUsage.input_tokens) || 0) +
      (Number(currentUsage.cache_read_input_tokens) || 0) +
      (Number(currentUsage.cache_creation_input_tokens) || 0)
    : 0;
  const promptTokens = exceeds200k ? Math.max(200_001, curPrompt) : curPrompt;

  return calculateTurnCost(
    {
      freshInputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      outputTokens: totOut,
      promptTokens,
    },
    pricing
  ).totalCostUsd;
}

/**
 * Format a USD cost cleanly in pure ASCII (safe for exact terminal cell width accounting).
 */
export function formatCost(usd, { compact = false } = {}) {
  const num = Number(usd);
  if (!Number.isFinite(num) || num <= 0) return '$0.00';
  if (compact) {
    if (num < 0.001) return '<$0.001';
    if (num < 0.1) return `$${num.toFixed(3)}`;
    if (num < 100) return `$${num.toFixed(2)}`;
    return `$${num.toFixed(1)}`;
  }
  if (num < 0.0001) return '<$0.0001';
  if (num < 0.01) return `$${num.toFixed(4)}`;
  if (num < 0.1) return `$${num.toFixed(3)}`;
  return `$${num.toFixed(2)}`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === SELF_FILE_PATH &&
  process.argv.includes('--sync-remote-pricing')
) {
  await syncRemotePricingCache();
}
