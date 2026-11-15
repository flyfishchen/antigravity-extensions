import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REMOTE_PRICING_URL,
  WEEKLY_PRICING_CACHE_TTL_MS,
  aggregateUsageStats,
  analyzeConversation,
  getPricingSignature,
  listRecentConversations,
  loadRemotePricingCache,
  locateConversation,
  syncRemotePricingCache,
} from './analyzer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,64}$/i;

class FallbackResponse {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

const STANDALONE_PRELOAD_JS = `(function () {
  const params = new URLSearchParams(window.location.search);
  const conversationId = params.get('conversationId') || '';
  window.sidecar = {
    conversationId,
    fetch: (url, options = {}) => fetch(url, options),
    getWorkspaceUris: async () => [],
    onWorkspaceChange: () => () => {},
    ui: {},
  };
})();
`;

class StandaloneSidecarApp {
  #port;
  #server;
  #pages = new Map();
  #apis = new Map();

  constructor(port = 8787) {
    this.#port = Number.isFinite(Number(port)) ? Number(port) : 8787;
  }

  get config() {
    return {
      projectId: process.env.ANTIGRAVITY_PROJECT_ID || '',
      conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || '',
    };
  }

  page(path, handler) {
    this.#pages.set(path, handler);
  }

  api(path, handler, method = 'POST') {
    if (!this.#apis.has(path)) {
      this.#apis.set(path, new Map());
    }
    this.#apis.get(path).set(method.toUpperCase(), handler);
  }

  run() {
    if (!this.#pages.has('/preload.js')) {
      this.#pages.set('/preload.js', () => STANDALONE_PRELOAD_JS);
    }

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${this.#port || 80}`);

      if (req.method === 'GET' && this.#pages.has(url.pathname)) {
        const content = await this.#pages.get(url.pathname)();
        if (content && typeof content === 'object' && content.body !== undefined) {
          res.writeHead(content.status || 200, {
            'Content-Type': content.contentType || 'text/plain',
            ...content.headers,
          });
          res.end(content.body);
          return;
        }
        const isJS = url.pathname.endsWith('.js');
        res.writeHead(200, {
          'Content-Type': isJS ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        });
        res.end(content);
        return;
      }

      if (this.#apis.has(url.pathname)) {
        const methodMap = this.#apis.get(url.pathname);
        if (methodMap.has(req.method)) {
          const handler = methodMap.get(req.method);
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', async () => {
            try {
              const data = {};
              if (req.method === 'GET' || url.searchParams.size > 0) {
                for (const [key, value] of url.searchParams.entries()) {
                  if (key.toLowerCase() !== 'token') {
                    data[key] = value;
                  }
                }
              }
              if (body) {
                Object.assign(data, JSON.parse(body));
              }
              const result = await handler(data);
              if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
                res.writeHead(result.status || 200, {
                  'Content-Type': result.contentType,
                  ...result.headers,
                });
                res.end(typeof result.body === 'string' ? result.body : Buffer.from(result.body));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    return new Promise((resolve) => {
      this.#server = server.listen(this.#port, '127.0.0.1', () => {
        const addr = server.address();
        console.log(`[context_monitor] standalone listening on 127.0.0.1:${addr?.port}`);
        resolve(server);
      });
    });
  }

  close() {
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}

async function resolveSidecarDriver(options = {}) {
  const forceStandalone =
    options.standalone === true ||
    process.argv.includes('--standalone') ||
    !process.env.ANTIGRAVITY_LS_ADDRESS ||
    !process.env.ANTIGRAVITY_CSRF_TOKEN ||
    !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;

  if (!forceStandalone) {
    try {
      const sdk = await import('sidecar_sdk');
      return {
        app: new sdk.SidecarApp(),
        ResponseClass: sdk.Response || FallbackResponse,
      };
    } catch {
      // Fall back cleanly if sidecar_sdk is unavailable outside the app host.
    }
  }

  const argPortIdx = process.argv.indexOf('--port');
  const cliPort = argPortIdx !== -1 ? Number(process.argv[argPortIdx + 1]) : NaN;
  const port =
    options.port !== undefined
      ? Number(options.port)
      : Number.isFinite(cliPort)
        ? cliPort
        : Number(process.env.PORT || 8787);

  return {
    app: new StandaloneSidecarApp(port),
    ResponseClass: FallbackResponse,
  };
}

export async function createMonitorApp(options = {}) {
  const { app, ResponseClass } = await resolveSidecarDriver(options);
  const dirs = options.dirs || null;
  const env = options.env || process.env;

  const htmlBytes = () => readFileSync(join(__dirname, 'index.html'), 'utf8');
  app.page('/', htmlBytes);
  app.page('/global', htmlBytes);

  app.api(
    '/styles.css',
    () => new ResponseClass(readFileSync(join(__dirname, 'styles.css'), 'utf8'), { contentType: 'text/css; charset=utf-8' }),
    'GET'
  );
  app.api(
    '/app.js',
    () =>
      new ResponseClass(readFileSync(join(__dirname, 'app.js'), 'utf8'), {
        contentType: 'application/javascript; charset=utf-8',
      }),
    'GET'
  );

  app.api(
    '/api/context',
    (data) => {
      const windowSize = Number(data.windowSize) || 0;
      const allowFallback =
        data.fallback === 'latest' || data.fallback === '1' || data.fallback === 'true';

      let convId =
        typeof data.conversationId === 'string' && data.conversationId.trim()
          ? data.conversationId.trim()
          : app.config?.conversationId || '';

      if ((!convId || !ID_RE.test(convId)) && allowFallback) {
        const recent = listRecentConversations({ limit: 1, windowSize, dirs, env });
        convId = recent[0]?.conversationId || '';
      }

      if (!convId || !ID_RE.test(convId)) {
        const etag = `empty|${windowSize}`;
        if (data.etag && data.etag === etag) {
          return { conversationId: null, found: false, unchanged: true, etag };
        }
        return { conversationId: null, found: false, etag };
      }

      const loc = locateConversation(convId, dirs, env);
      if (!loc) {
        const etag = `missing|${convId}|${windowSize}`;
        if (data.etag && data.etag === etag) {
          return { conversationId: convId, found: false, unchanged: true, etag };
        }
        return { conversationId: convId, found: false, etag };
      }

      const analysis = analyzeConversation(convId, {
        windowSize,
        dirs,
        env,
        cacheDir: options.cacheDir,
        disableRemoteRefresh: options.disableRemoteRefresh,
      });
      if (!analysis) {
        return { conversationId: convId, found: false, etag: `missing|${convId}|${windowSize}` };
      }

      const pricingSig = getPricingSignature({ env, cacheDir: options.cacheDir });
      const subKey = (analysis.subagents || [])
        .map((s) => `${s.conversationId}:${s.mtimeMs || 0}`)
        .join(',');
      const etag = `${convId}|${windowSize}|${pricingSig}|${analysis.mtimeMs || 0}:${analysis.fileSize || 0}|${subKey}`;
      if (data.etag && data.etag === etag) {
        return { conversationId: convId, found: true, unchanged: true, etag };
      }

      return {
        found: true,
        etag,
        ...analysis,
      };
    },
    'GET'
  );

  app.api(
    '/api/conversations',
    (data) => {
      const limit = Math.max(1, Math.min(100, Number(data.limit) || 30));
      const windowSize = Number(data.windowSize) || 0;
      const pricingSig = getPricingSignature({ env, cacheDir: options.cacheDir });
      const conversations = listRecentConversations({
        limit,
        windowSize,
        dirs,
        env,
        cacheDir: options.cacheDir,
        disableRemoteRefresh: options.disableRemoteRefresh,
      });
      const etag =
        `${limit}|${windowSize}|${pricingSig}|` +
        conversations.map((c) => `${c.conversationId}:${c.mtimeMs}:${c.size}`).join(';');
      if (data.etag && data.etag === etag) {
        return { unchanged: true, etag };
      }
      const roundUsd = (n) => Math.round((Number(n) || 0) * 1e8) / 1e8;
      const totals = conversations.reduce(
        (acc, c) => {
          acc.count += 1;
          acc.totalCostUsd = roundUsd(acc.totalCostUsd + (Number(c.costUsd) || 0));
          acc.totalCacheSavingsUsd = roundUsd(
            acc.totalCacheSavingsUsd + (Number(c.cacheSavingsUsd) || 0)
          );
          return acc;
        },
        { count: 0, totalCostUsd: 0, totalCacheSavingsUsd: 0 }
      );
      return {
        conversations,
        totals,
        etag,
      };
    },
    'GET'
  );

  app.api(
    '/api/stats',
    (data) => {
      const period = typeof data.period === 'string' && data.period.trim() ? data.period.trim() : 'week';
      const from = typeof data.from === 'string' ? data.from.trim() : '';
      const to = typeof data.to === 'string' ? data.to.trim() : '';
      const surface = typeof data.surface === 'string' ? data.surface.trim() : 'all';
      const windowSize = Number(data.windowSize) || 0;
      const pricingSig = getPricingSignature({ env, cacheDir: options.cacheDir });
      const stats = aggregateUsageStats({
        period,
        from,
        to,
        surface,
        windowSize,
        dirs,
        env,
        cacheDir: options.cacheDir,
        disableRemoteRefresh: options.disableRemoteRefresh,
      });
      const etag = `${stats.period}|${stats.range.fromMs}:${stats.range.toMs}|${stats.surfaceFilter}|${windowSize}|${pricingSig}|${stats.totals.sessionsCount}:${stats.totals.turnsCount}:${stats.totals.totalTokens}:${stats.totals.costUsd}`;
      if (data.etag && data.etag === etag) {
        return { unchanged: true, etag };
      }
      return {
        etag,
        ...stats,
      };
    },
    'GET'
  );

  app.api(
    '/api/pricing',
    () => {
      const cache = loadRemotePricingCache({
        env,
        cacheDir: options.cacheDir,
        disableRemoteRefresh: true,
      });
      return {
        defaultUrl: DEFAULT_REMOTE_PRICING_URL,
        ttlMs: WEEKLY_PRICING_CACHE_TTL_MS,
        cache: cache
          ? {
              sourceUrl: cache.sourceUrl,
              fetchedAt: cache.fetchedAt,
              downloadedAt: cache.downloadedAt,
              checkedAt: cache.checkedAt,
              lastModified: cache.lastModified,
              expiresAt: cache.expiresAt,
              stale: cache.stale,
              modelCount: cache.modelCount,
            }
          : null,
      };
    },
    'GET'
  );

  app.api(
    '/api/pricing/refresh',
    async (data = {}) =>
      syncRemotePricingCache({
        env,
        cacheDir: options.cacheDir,
        force: true,
        forceDownload: Boolean(data?.forceDownload),
      }),
    'POST'
  );

  if (
    options.disableRemoteRefresh !== true &&
    (!process.env.NODE_TEST_CONTEXT || env?.AGY_CTX_PRICING_URL)
  ) {
    void syncRemotePricingCache({ env, cacheDir: options.cacheDir }).catch(() => {});
    const refreshTimer = setInterval(() => {
      void syncRemotePricingCache({ env, cacheDir: options.cacheDir }).catch(() => {});
    }, 6 * 60 * 60 * 1000);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }

  return app;
}

const isMain = process.argv[1] && process.argv[1].endsWith('main.mjs');
if (isMain) {
  const app = await createMonitorApp();
  await app.run();
}
