(() => {
  const POLL_MS = 1500;
  const LIST_POLL_MS = 3500;
  const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 50; // ~314.159

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function formatTokens(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num < 0) return '0';
    if (num < 1000) return String(Math.round(num));
    if (num < 100_000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    if (num < 1_000_000) return `${Math.round(num / 1000)}k`;
    return `${(num / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }

  function formatPct(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return '0%';
    if (num < 10) return `${num.toFixed(1).replace(/\.0$/, '')}%`;
    return `${Math.round(num)}%`;
  }

  function formatCost(usd, compact = false) {
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

  function luminanceOfCssColor(expr, baseLum = null) {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;color:${expr}`;
    document.documentElement.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const nums = (color.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return null;
    const scale = color.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (baseLum !== null && nums.length >= 4) {
      const alpha = Math.min(1, Math.max(0, nums[3]));
      return baseLum + (lum - baseLum) * alpha;
    }
    return lum;
  }

  function syncTheme() {
    const bgLum = luminanceOfCssColor('var(--background, #f6f8fa)');
    if (bgLum === null) return;
    const theme = bgLum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }

    const rawMuted = getComputedStyle(document.documentElement)
      .getPropertyValue('--muted-foreground')
      .trim();
    let mutedContrast = 'fallback';
    if (rawMuted) {
      const mutedLum = luminanceOfCssColor('var(--muted-foreground)', bgLum);
      if (mutedLum !== null && Math.abs(mutedLum - bgLum) >= 0.25) {
        mutedContrast = 'host';
      }
    }
    if (document.documentElement.dataset.mutedContrast !== mutedContrast) {
      document.documentElement.dataset.mutedContrast = mutedContrast;
    }
  }

  syncTheme();
  new MutationObserver(() => syncTheme()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  const params = new URLSearchParams(location.search);
  const hostConvId = window.sidecar?.conversationId || params.get('conversationId') || '';
  const isGlobalRoute = location.pathname.endsWith('/global');
  const requestedTab = params.get('tab');

  const state = {
    tab: requestedTab === 'stats' ? 'stats' : isGlobalRoute || !hostConvId ? 'sessions' : 'session',
    convId: hostConvId,
    windowSize: 0,
    contextEtag: '',
    listEtag: '',
    statsEtag: '',
    contextData: null,
    conversations: [],
    statsData: null,
    statsPeriod: 'week',
    statsFrom: '',
    statsTo: '',
    statsSurface: 'all',
    searchQuery: '',
    surfaceFilter: 'all',
    sortOrder: 'recent',
    compactConfirm: false,
    compactTimer: null,
  };

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body = {}) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function setLiveStatus(ok) {
    const pill = $('live-pill');
    const label = $('live-label');
    if (ok) {
      pill.classList.remove('stale');
      label.textContent = 'Live';
    } else {
      pill.classList.add('stale');
      label.textContent = 'Reconnecting';
    }
  }

  function switchTab(nextTab) {
    state.tab = nextTab;
    for (const name of ['session', 'sessions', 'stats']) {
      const active = name === nextTab;
      $(`tab-btn-${name}`).classList.toggle('active', active);
      $(`tab-btn-${name}`).setAttribute('aria-selected', String(active));
      $(`panel-${name}`).classList.toggle('active', active);
    }
    if (nextTab === 'stats') {
      pollStats();
    }
  }

  function colorForModelRole(role, idx = 0) {
    if (role === 'planner') return 'var(--ctx-c-planner)';
    if (role === 'worker') return 'var(--ctx-c-worker)';
    return idx % 2 === 0 ? 'var(--ctx-c-system)' : 'var(--ctx-c-model)';
  }

  function renderModelBreakdown(mb) {
    const card = $('models-card');
    const visible = Boolean(mb?.isMultiModel && Array.isArray(mb.models));
    card.classList.toggle('hidden', !visible);
    if (!visible) return;

    $('models-card-title').textContent = mb.isOrchestrator
      ? 'Orchestrator Dual-Model'
      : 'Model Breakdown';
    const sw = Number(mb.switchCount) || 0;
    $('models-switches-pill').textContent =
      sw > 0 ? `⇄ ${sw} switch${sw === 1 ? '' : 'es'}` : 'No switches yet';

    $('models-stacked-bar').innerHTML = mb.models
      .map((m, idx) => {
        if (!(m.totalTokens > 0)) return '';
        const color = colorForModelRole(m.role, idx);
        const tip = `${m.label}${m.model ? ` (${m.model})` : ''}: ${formatTokens(m.totalTokens)} (${formatPct(m.sharePercentage)})`;
        return `<div class="stacked-seg" style="width:${Math.max(1, m.sharePercentage)}%;background:${color}" title="${esc(tip)}"></div>`;
      })
      .join('');

    $('models-rows').innerHTML = mb.models
      .map((m, idx) => {
        const color = colorForModelRole(m.role, idx);
        const showRawId = m.model && m.model !== m.label;
        const turnsLabel = `${m.invocations} turn${m.invocations === 1 ? '' : 's'} · ${formatCost(m.costUsd, true)} · ${formatPct(m.sharePercentage)}`;
        const metricsHtml =
          m.invocations === 0
            ? '<span>No invocations in this phase yet</span>'
            : `<span>In <strong>${esc(formatTokens(m.totalInputTokens))}</strong> (Fresh ${esc(formatTokens(m.uncachedInputTokens))} · Cache ${esc(formatTokens(m.cacheReadTokens))} · ⚡${esc(formatPct(m.cacheHitRate))})</span><span>Out <strong>${esc(formatTokens(m.outputTokens))}</strong></span><span>Cost <strong>${esc(formatCost(m.costUsd))}</strong> (${esc(formatPct(m.costSharePercentage))})</span>`;
        return `
          <div class="model-item">
            <div class="model-item-top">
              <div class="model-item-left">
                <span class="cat-dot" style="background:${color}"></span>
                <span class="model-role-name">${esc(m.label)}</span>
                ${showRawId ? `<span class="model-raw-id" title="${esc(m.model)}">${esc(m.model)}</span>` : ''}
              </div>
              <span class="model-item-right">${esc(turnsLabel)}</span>
            </div>
            <div class="model-item-metrics">${metricsHtml}</div>
          </div>
        `;
      })
      .join('');
  }

  function renderTurnChart(turns, windowSize, modelBreakdown) {
    const wrap = $('turn-chart-wrap');
    const info = $('turn-hover-info');
    const showPhaseLegend = Boolean(modelBreakdown?.isOrchestrator);
    $('lg-planner').classList.toggle('hidden', !showPhaseLegend);
    $('lg-worker').classList.toggle('hidden', !showPhaseLegend);

    if (!Array.isArray(turns) || turns.length === 0) {
      wrap.innerHTML = '<div class="muted small">No model invocations recorded yet.</div>';
      info.textContent = 'Turn growth chart appears after the first model response.';
      return;
    }

    const recent = turns.slice(-24);
    const maxPrompt = Math.max(
      1,
      ...recent.map((t) => Number(t.promptTokens) || 0),
      Math.round((Number(windowSize) || 0) * 0.05)
    );

    const w = Math.max(280, recent.length * 22 + 16);
    const h = 118;
    const stepW = (w - 16) / recent.length;
    const barW = Math.max(8, Math.min(18, Math.floor(stepW) - 4));
    const plotTop = 10;
    const plotBottom = 90;
    const plotH = plotBottom - plotTop;
    const roleStripY = 94;
    const labelY = 110;
    const isMultiModel = Boolean(modelBreakdown?.isMultiModel);
    const modelsList = Array.isArray(modelBreakdown?.models) ? modelBreakdown.models : [];

    const barsSvg = recent
      .map((t, idx) => {
        const x = 8 + idx * stepW;
        const total = Number(t.promptTokens) || 0;
        const cached = Math.min(total, Number(t.cacheReadTokens) || 0);
        const fresh = Math.max(0, total - cached);

        const totalH = total > 0 ? Math.max(4, Math.round((total / maxPrompt) * plotH)) : 0;
        const cachedH = total > 0 ? Math.round((cached / total) * totalH) : 0;
        const freshH = Math.max(0, totalH - cachedH);

        const cachedY = plotBottom - cachedH;
        const freshY = cachedY - freshH;
        const compMark = t.compacted
          ? `<circle cx="${(x + barW / 2).toFixed(1)}" cy="5" r="2.5" fill="var(--ctx-c-model)" />`
          : '';

        let switchLine = '';
        let roleStrip = '';
        if (isMultiModel) {
          const singleIdx =
            t.modelRole === 'single'
              ? Math.max(
                  0,
                  modelsList.findIndex(
                    (m) => (t.rawModel && m.model === t.rawModel) || m.label === t.modelRoleLabel
                  )
                )
              : 0;
          const stripColor = colorForModelRole(t.modelRole, singleIdx);
          roleStrip = `<rect x="${x.toFixed(1)}" y="${roleStripY}" width="${barW}" height="3.5" rx="1.75" fill="${stripColor}" />`;
          if (idx > 0 && t.modelSwitched) {
            const prevRight = 8 + (idx - 1) * stepW + barW;
            const midX = ((prevRight + x) / 2).toFixed(1);
            switchLine = `<line x1="${midX}" y1="${plotTop - 2}" x2="${midX}" y2="98" stroke="var(--ctx-fg-muted)" stroke-width="1" stroke-dasharray="2 2" opacity="0.65" />`;
          }
        }

        return `
          <g class="turn-bar-group" tabindex="0" data-idx="${idx}">
            ${switchLine}
            <rect class="turn-bg" x="${(x - 2).toFixed(1)}" y="${plotTop - 4}" width="${barW + 4}" height="${plotH + 12}" rx="3" fill="transparent" />
            ${compMark}
            <rect x="${x.toFixed(1)}" y="${freshY.toFixed(1)}" width="${barW}" height="${freshH.toFixed(1)}" rx="2" fill="var(--ctx-c-system)" />
            <rect x="${x.toFixed(1)}" y="${cachedY.toFixed(1)}" width="${barW}" height="${cachedH.toFixed(1)}" rx="2" fill="var(--ctx-c-healthy)" />
            ${roleStrip}
            <text x="${(x + barW / 2).toFixed(1)}" y="${labelY}" text-anchor="middle" font-size="9" fill="var(--ctx-fg-muted)">#${t.turnNumber}</text>
          </g>
        `;
      })
      .join('');

    wrap.innerHTML = `<svg class="turn-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${barsSvg}</svg>`;

    const showTurn = (idx) => {
      const t = recent[idx];
      if (!t) return;
      const deltaStr =
        t.deltaTokens >= 0 ? `+${formatTokens(t.deltaTokens)}` : `-${formatTokens(-t.deltaTokens)}`;
      const toolsStr = t.tools?.length ? ` · Tools: ${t.tools.slice(0, 3).join(', ')}` : '';
      const compStr = t.compacted ? ' · [Compacted]' : '';
      const tierStr = t.longContextTier ? ' [>200k tier]' : '';
      const costStr = ` · ${formatCost(t.costUsd)}${tierStr}`;
      if (isMultiModel) {
        const swNote = t.modelSwitched ? ' · ⇄ Switched' : '';
        const rolePart = t.modelTag
          ? ` [${t.modelTag}${t.rawModel ? ` · ${t.rawModel}` : ''}${swNote}]`
          : t.rawModel
            ? ` [${t.rawModel}${swNote}]`
            : '';
        info.textContent = `Turn #${t.turnNumber}${rolePart}: ${formatTokens(t.promptTokens)} prompt (${deltaStr}), ${formatPct(t.cacheHitRate)} cached, ${formatTokens(t.outputTokens)} out${costStr}${compStr}${toolsStr}`;
      } else {
        info.textContent = `Turn #${t.turnNumber}: ${formatTokens(t.promptTokens)} prompt (${deltaStr}), ${formatPct(t.cacheHitRate)} cached, ${formatTokens(t.outputTokens)} out${costStr}${compStr}${toolsStr}`;
      }
    };

    wrap.querySelectorAll('.turn-bar-group').forEach((el) => {
      const idx = Number(el.dataset.idx);
      el.addEventListener('mouseenter', () => showTurn(idx));
      el.addEventListener('focus', () => showTurn(idx));
    });
    showTurn(recent.length - 1);
  }

  function renderSession(data) {
    $('session-loading').classList.add('hidden');
    if (!data || !data.found) {
      $('session-content').classList.add('hidden');
      $('session-empty').classList.remove('hidden');
      $('session-empty-sub').textContent = state.convId
        ? `Waiting for transcript in ${state.convId.slice(0, 8)}…`
        : 'Select a session from All Sessions to inspect context usage.';
      return;
    }

    $('session-empty').classList.add('hidden');
    $('session-content').classList.remove('hidden');

    $('conv-title').textContent = data.title || 'Untitled conversation';
    $('conv-surface').textContent = (data.product || 'app').toUpperCase();
    $('conv-model').textContent = data.modelLabel || data.model || 'Unknown model';

    const mb = data.modelBreakdown || {
      isOrchestrator: false,
      isMultiModel: false,
      switchCount: 0,
      models: [],
    };
    const phaseBadge = $('conv-phase-badge');
    if (mb.isOrchestrator) {
      phaseBadge.textContent = mb.activeTag
        ? `${mb.activeTag} · ${mb.activeRoleLabel}`
        : mb.activeRoleLabel;
      phaseBadge.title = mb.activeModel
        ? `Active underlying model: ${mb.activeModel}`
        : mb.activeRoleLabel;
      phaseBadge.className = `badge ${mb.activeRole === 'worker' ? 'phase-worker' : 'phase-planner'}`;
    } else {
      phaseBadge.className = 'badge hidden';
      phaseBadge.textContent = '';
    }

    const swPill = $('conv-switches-pill');
    const showSwitches = Boolean(mb.isMultiModel && mb.switchCount > 0);
    swPill.classList.toggle('hidden', !showSwitches);
    if (showSwitches) {
      swPill.textContent = `⇄ ${mb.switchCount} switch${mb.switchCount === 1 ? '' : 'es'}`;
    }

    $('conv-id').textContent = data.conversationId ? data.conversationId.slice(0, 8) : '';
    $('conv-turns-pill').textContent = `${data.sessionTotals?.invocations || 0} turns`;
    const cost = data.cost || {};
    const costPill = $('conv-cost-pill');
    costPill.textContent = formatCost(cost.totalCostUsd, true);
    costPill.title =
      (cost.totalWithSubagentsUsd || 0) > (cost.totalCostUsd || 0)
        ? `Session ${formatCost(cost.totalCostUsd)} · Combined w/ subagents ${formatCost(cost.totalWithSubagentsUsd)}`
        : `Estimated session cost ${formatCost(cost.totalCostUsd)}`;

    const openConvBtn = $('btn-open-conv');
    const canToggleConv = Boolean(
      window.sidecar?.ui?.toggleConversation &&
        data.conversationId &&
        data.conversationId !== hostConvId
    );
    openConvBtn.classList.toggle('hidden', !canToggleConv);
    openConvBtn.onclick = () => {
      if (window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(data.conversationId);
      }
    };

    const pct = Math.max(0, Math.min(100, Number(data.usedPercentage) || 0));
    const health = data.health || 'healthy';
    const arc = $('gauge-arc');
    const offset = GAUGE_CIRCUMFERENCE * (1 - pct / 100);
    arc.setAttribute('stroke-dashoffset', offset.toFixed(2));
    arc.setAttribute('class', `gauge-arc ${health}`);

    $('gauge-pct').textContent = formatPct(pct);
    $('gauge-health').textContent = health.toUpperCase();

    $('active-tokens').textContent = formatTokens(data.activeContextTokens);
    $('window-tokens').textContent = formatTokens(data.contextWindowSize);
    const fill = $('linear-fill');
    fill.style.width = `${Math.min(100, Math.max(pct > 0 ? 2 : 0, pct))}%`;
    fill.className = `linear-fill ${health}`;

    $('headroom-text').textContent = `${formatTokens(data.remainingTokens)} remaining (${formatPct(data.remainingPercentage)})`;
    $('badge-200k').classList.toggle('hidden', !data.exceeds200k);

    const canSendCompact = Boolean(
      window.sidecar?.agent?.sendMessage &&
        data.conversationId &&
        pct >= 65
    );
    $('compact-wrap').classList.toggle('hidden', !canSendCompact);

    // Categories
    $('breakdown-total').textContent = `${formatTokens(data.activeContextTokens)} active`;
    const cats = [
      { key: 'systemAndTools', label: 'System & Tools', color: 'var(--ctx-c-system)' },
      { key: 'userInputs', label: 'User Inputs', color: 'var(--ctx-c-user)' },
      { key: 'modelOutputs', label: 'Model Thinking & Output', color: 'var(--ctx-c-model)' },
      { key: 'toolResults', label: 'Tool Results & File Reads', color: 'var(--ctx-c-tool)' },
    ];

    $('cat-stacked-bar').innerHTML = cats
      .map((c) => {
        const stat = data.categories?.[c.key] || { tokens: 0, percentage: 0 };
        if (stat.tokens <= 0) return '';
        return `<div class="stacked-seg" style="width:${Math.max(1, stat.percentage)}%;background:${c.color}" title="${esc(c.label)}: ${formatTokens(stat.tokens)} (${formatPct(stat.percentage)})"></div>`;
      })
      .join('');

    $('cat-rows').innerHTML = cats
      .map((c) => {
        const stat = data.categories?.[c.key] || { tokens: 0, percentage: 0 };
        return `
          <div class="cat-row">
            <span class="cat-dot" style="background:${c.color}"></span>
            <span class="cat-name">${esc(c.label)}</span>
            <span class="cat-val">${esc(formatTokens(stat.tokens))}</span>
            <span class="cat-pct">${esc(formatPct(stat.percentage))}</span>
          </div>
        `;
      })
      .join('');

    // KPIs
    const tot = data.sessionTotals || {};
    $('kpi-cache-rate').textContent = formatPct(tot.cacheHitRate || 0);
    $('kpi-cache-read').textContent = formatTokens(tot.cacheReadTokens || 0);
    $('kpi-fresh-in').textContent = formatTokens(tot.uncachedInputTokens || 0);
    $('kpi-total-out').textContent = formatTokens(tot.outputTokens || 0);
    $('latest-cache-pill').textContent = `Latest: ${formatPct(tot.latestTurnCacheHitRate || 0)}`;

    // Cost & Cache Savings
    const avgPill = $('cost-avg-pill');
    avgPill.textContent =
      cost.longContextTurns > 0
        ? `Avg ${formatCost(cost.avgTurnCostUsd)}/turn · ${cost.longContextTurns} >200k`
        : `Avg ${formatCost(cost.avgTurnCostUsd)}/turn`;
    const lmInfo = cost.pricingCache?.lastModified
      ? `, Last-Modified: ${cost.pricingCache.lastModified}`
      : '';
    avgPill.title = cost.pricingCache
      ? `Pricing: ${cost.pricingSource === 'remote-cache' ? 'BaseLLM weekly cache' : cost.pricingSource || 'built-in'} (${cost.pricingCache.modelCount} models cached, synced ${new Date(cost.pricingCache.fetchedAt).toISOString().slice(0, 10)}${lmInfo})`
      : `Pricing source: ${cost.pricingSource || 'built-in'}`;
    $('kpi-total-cost').textContent = formatCost(cost.totalCostUsd);
    const subNote = $('kpi-subagent-cost-note');
    const subs = data.subagents || [];
    if (subs.length > 0 && (cost.totalWithSubagentsUsd || 0) > (cost.totalCostUsd || 0)) {
      subNote.textContent = `Combined w/ subagents: ${formatCost(cost.totalWithSubagentsUsd)}`;
      subNote.classList.remove('hidden');
    } else {
      subNote.textContent = '';
      subNote.classList.add('hidden');
    }
    $('kpi-cache-savings').textContent = `${formatCost(cost.cacheSavingsUsd)} (${formatPct(cost.cacheSavingsPercentage || 0)})`;
    $('kpi-in-cost').textContent = formatCost((cost.inputCostUsd || 0) + (cost.cacheReadCostUsd || 0));
    $('kpi-out-cost').textContent = formatCost(cost.outputCostUsd);

    const costParts = [
      { label: 'Fresh/Write Input', value: cost.inputCostUsd || 0, color: 'var(--ctx-c-system)' },
      { label: 'Cache Read', value: cost.cacheReadCostUsd || 0, color: 'var(--ctx-c-healthy)' },
      { label: 'Output', value: cost.outputCostUsd || 0, color: 'var(--ctx-c-model)' },
    ];
    const costSum = costParts.reduce((s, p) => s + p.value, 0);
    $('cost-stacked-bar').innerHTML =
      costSum > 0
        ? costParts
            .map((p) => {
              if (p.value <= 0) return '';
              const pctShare = (p.value / costSum) * 100;
              return `<div class="stacked-seg" style="width:${Math.max(1, pctShare)}%;background:${p.color}" title="${esc(p.label)}: ${esc(formatCost(p.value))} (${esc(formatPct(pctShare))})"></div>`;
            })
            .join('')
        : '';

    // Orchestrator / Multi-Model Breakdown
    renderModelBreakdown(mb);

    // Turn Chart
    renderTurnChart(data.turns || [], data.contextWindowSize, mb);

    // Top Consumers
    const consumers = data.topConsumers || [];
    if (consumers.length === 0) {
      $('top-consumers').innerHTML = '<div class="muted small">No context growth turns yet.</div>';
    } else {
      $('top-consumers').innerHTML = consumers
        .map(
          (c) => `
            <div class="list-row">
              <div class="list-left">
                <div class="list-title" title="${esc(c.label)}">${esc(c.label)}</div>
                <div class="list-sub">Turn #${esc(c.turnNumber)}</div>
              </div>
              <div class="list-right delta-pos">+${esc(formatTokens(c.deltaTokens))}</div>
            </div>
          `
        )
        .join('');
    }

    // Subagents
    $('subagents-card').classList.toggle('hidden', subs.length === 0);
    if (subs.length > 0) {
      const subTot = data.subagentsTotals || {};
      $('subagents-summary').textContent = `${subs.length} · ${formatTokens(subTot.activeContextTokens)} active · ${formatCost(subTot.costUsd)}`;
      $('subagents-list').innerHTML = subs
        .map(
          (s) => `
            <div class="list-row clickable" data-sub-id="${esc(s.conversationId)}">
              <div class="list-left">
                <div class="list-title">${esc(s.name)}</div>
                <div class="list-sub">${esc(s.role)} · ${esc(s.modelLabel || s.model)}</div>
              </div>
              <div class="list-right">${esc(formatTokens(s.activeContextTokens))} (${esc(formatPct(s.usedPercentage))}) · ${esc(formatCost(s.costUsd, true))}</div>
            </div>
          `
        )
        .join('');
      $('subagents-list').querySelectorAll('[data-sub-id]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.dataset.subId;
          if (!id) return;
          selectConversation(id);
        });
      });
    }
  }

  function renderSessionsList() {
    const q = state.searchQuery.trim().toLowerCase();
    const filtered = (state.conversations || []).filter((c) => {
      if (state.surfaceFilter !== 'all' && c.product !== state.surfaceFilter) return false;
      if (!q) return true;
      return (
        String(c.title || '').toLowerCase().includes(q) ||
        String(c.modelLabel || c.model || '').toLowerCase().includes(q) ||
        String(c.conversationId || '').toLowerCase().includes(q)
      );
    });

    if (state.sortOrder === 'cost') {
      filtered.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || (b.mtimeMs || 0) - (a.mtimeMs || 0));
    } else if (state.sortOrder === 'context') {
      filtered.sort(
        (a, b) =>
          (b.activeContextTokens || 0) - (a.activeContextTokens || 0) ||
          (b.mtimeMs || 0) - (a.mtimeMs || 0)
      );
    }

    const badge = $('sessions-count');
    badge.textContent = String((state.conversations || []).length);
    badge.classList.toggle('hidden', !(state.conversations || []).length);

    const filteredCost = filtered.reduce((sum, c) => sum + (Number(c.costUsd) || 0), 0);
    const filteredSaved = filtered.reduce((sum, c) => sum + (Number(c.cacheSavingsUsd) || 0), 0);
    $('sessions-summary').textContent =
      `${filtered.length} session${filtered.length === 1 ? '' : 's'} · Total ${formatCost(filteredCost)} · Cache saved ${formatCost(filteredSaved)}`;

    const container = $('sessions-list');
    if (filtered.length === 0) {
      container.innerHTML = '<div class="card empty-card"><div class="empty-title">No matching sessions</div></div>';
      return;
    }

    container.innerHTML = filtered
      .map((c) => {
        const pct = Math.max(0, Math.min(100, Number(c.usedPercentage) || 0));
        const selected = c.conversationId === state.convId ? 'selected' : '';
        const modelMeta = [
          c.modelLabel || c.model || 'Unknown',
          c.isOrchestrator && c.activeTag ? c.activeTag : '',
          c.switchCount > 0 ? `⇄${c.switchCount}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return `
          <div class="session-item ${selected}" data-conv-id="${esc(c.conversationId)}">
            <div class="session-item-top">
              <div class="session-item-title">${esc(c.title)}</div>
              <div class="session-item-badges">
                <span class="session-cost-tag">${esc(formatCost(c.costUsd, true))}</span>
                <span class="badge surface">${esc(c.product)}</span>
              </div>
            </div>
            <div class="linear-track" aria-hidden="true">
              <div class="linear-fill ${esc(c.health || 'healthy')}" style="width:${Math.min(100, Math.max(pct > 0 ? 2 : 0, pct))}%"></div>
            </div>
            <div class="session-item-meta">
              <span>${esc(formatTokens(c.activeContextTokens))} / ${esc(formatTokens(c.contextWindowSize))} (${esc(formatPct(pct))})</span>
              <span>${esc(modelMeta)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('.session-item').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.convId;
        if (id) selectConversation(id);
      });
    });
  }

  function selectConversation(id) {
    state.convId = id;
    state.contextEtag = '';
    $('session-loading').classList.remove('hidden');
    $('session-empty').classList.add('hidden');
    $('session-content').classList.add('hidden');
    switchTab('session');
    pollContext();
  }

  async function pollContext() {
    if (!state.convId) {
      renderSession({ found: false });
      return;
    }
    try {
      const qs = new URLSearchParams({
        conversationId: state.convId,
        windowSize: String(state.windowSize || 0),
        etag: state.contextEtag || '',
      });
      const data = await apiGet(`/api/context?${qs.toString()}`);
      setLiveStatus(true);
      if (data.etag) state.contextEtag = data.etag;
      if (!data.unchanged) {
        state.contextData = data;
        renderSession(data);
      }
    } catch {
      setLiveStatus(false);
    }
  }

  async function pollConversations() {
    try {
      const qs = new URLSearchParams({
        limit: '30',
        windowSize: String(state.windowSize || 0),
        etag: state.listEtag || '',
      });
      const data = await apiGet(`/api/conversations?${qs.toString()}`);
      setLiveStatus(true);
      if (data.etag) state.listEtag = data.etag;
      if (!data.unchanged && Array.isArray(data.conversations)) {
        state.conversations = data.conversations;
        renderSessionsList();
      }
    } catch {
      setLiveStatus(false);
    }
  }

  function formatDatetimeLocalValue(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderStatsChart(buckets, granularity) {
    const wrap = $('stats-chart-wrap');
    const info = $('stats-hover-info');
    if (!Array.isArray(buckets) || buckets.length === 0) {
      wrap.innerHTML = '<div class="empty-sub">No activity recorded in this time range.</div>';
      info.textContent = 'Select a broader date range or Day / Week / Month / All preset.';
      return;
    }

    const visible = buckets.slice(-31);
    const maxCost = Math.max(0, ...visible.map((b) => Number(b.costUsd) || 0));
    const maxTok = Math.max(1, ...visible.map((b) => Number(b.totalTokens) || 0));
    const w = Math.max(280, visible.length * 22 + 16);
    const h = 114;
    const stepW = (w - 16) / visible.length;
    const barW = Math.max(7, Math.min(18, Math.floor(stepW) - 4));
    const plotTop = 10;
    const plotBottom = 90;
    const plotH = plotBottom - plotTop;
    const labelY = 106;
    const labelStride = visible.length > 16 ? Math.ceil(visible.length / 8) : 1;

    const barsSvg = visible
      .map((b, idx) => {
        const x = 8 + idx * stepW;
        const val = maxCost > 0 ? Number(b.costUsd) || 0 : Number(b.totalTokens) || 0;
        const maxVal = maxCost > 0 ? maxCost : maxTok;
        const barH = val > 0 ? Math.max(4, Math.round((val / maxVal) * plotH)) : 2;
        const y = plotBottom - barH;
        const fill = val > 0 ? 'var(--ctx-accent)' : 'var(--ctx-border)';
        const showLabel = idx % labelStride === 0 || idx === visible.length - 1;
        const lblText = showLabel
          ? `<text x="${(x + barW / 2).toFixed(1)}" y="${labelY}" text-anchor="middle" font-size="9" fill="var(--ctx-fg-muted)">${esc(b.label)}</text>`
          : '';
        return `
          <g class="stats-bar-group" tabindex="0" data-sidx="${idx}">
            <rect class="turn-bg" x="${(x - 2).toFixed(1)}" y="${plotTop - 4}" width="${barW + 4}" height="${plotH + 10}" rx="3" fill="transparent" />
            <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${barH}" rx="2" fill="${fill}" />
            ${lblText}
          </g>
        `;
      })
      .join('');

    wrap.innerHTML = `<svg class="turn-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${barsSvg}</svg>`;

    const showBucket = (idx) => {
      const b = visible[idx];
      if (!b) return;
      const hitPct =
        b.totalInputTokens > 0 ? ((b.cacheReadTokens / b.totalInputTokens) * 100) : 0;
      info.textContent = `${b.label} (${granularity}): ${b.sessionsCount} session${b.sessionsCount === 1 ? '' : 's'}, ${b.turnsCount} turns · ${formatTokens(b.totalInputTokens)} in / ${formatTokens(b.outputTokens)} out · ⚡${formatPct(hitPct)} · ${formatCost(b.costUsd)} (saved ${formatCost(b.cacheSavingsUsd)})`;
    };

    wrap.querySelectorAll('.stats-bar-group').forEach((el) => {
      const idx = Number(el.dataset.sidx);
      el.addEventListener('mouseenter', () => showBucket(idx));
      el.addEventListener('focus', () => showBucket(idx));
    });
    const nonZeroIdx = visible.findLastIndex((b) => (b.turnsCount || 0) > 0);
    showBucket(nonZeroIdx >= 0 ? nonZeroIdx : visible.length - 1);
  }

  function renderStats(stats) {
    if (!stats) return;
    const t = stats.totals || {};
    const r = stats.range || {};
    $('stats-range-summary').textContent = `${r.fromLabel || ''} → ${r.toLabel || ''} (${r.spanDays || 1}d)`;
    const pc = stats.pricingCache;
    if (pc?.lastModified) {
      $('stats-pricing-note').textContent = `Rates: Last-Modified ${pc.lastModified.slice(0, 22)}`;
      $('stats-pricing-note').title = `Source: ${pc.sourceUrl}\nLast-Modified: ${pc.lastModified}\nChecked: ${new Date(pc.checkedAt || pc.fetchedAt).toLocaleString()}`;
    } else if (pc) {
      $('stats-pricing-note').textContent = `Rates: ${pc.modelCount} models cached`;
    } else {
      $('stats-pricing-note').textContent = `Rates: ${stats.pricingSource || 'builtin'}`;
    }

    $('stats-sessions-pill').textContent = `${t.sessionsCount || 0} sessions`;
    $('stats-kpi-cost').textContent = formatCost(t.costUsd);
    $('stats-kpi-avg-day').textContent = formatCost(t.avgDailyCostUsd);
    $('stats-kpi-saved').textContent = `${formatCost(t.cacheSavingsUsd)} (${formatPct(t.cacheSavingsPercentage)})`;
    $('stats-kpi-hit-rate').textContent = formatPct(t.cacheHitRate);
    $('stats-kpi-in').textContent = formatTokens(t.totalInputTokens);
    $('stats-kpi-cached').textContent = formatTokens(t.cacheReadTokens);
    $('stats-kpi-out').textContent = formatTokens(t.outputTokens);
    $('stats-kpi-sessions').textContent = `${t.sessionsCount || 0} / ${t.turnsCount || 0}`;
    $('stats-granularity-pill').textContent = `by ${stats.granularity || 'day'}`;

    renderStatsChart(stats.buckets || [], stats.granularity || 'day');

    const models = stats.byModel || [];
    $('stats-models-count').textContent = `${models.length} model${models.length === 1 ? '' : 's'}`;
    const palette = ['var(--ctx-c-system)', 'var(--ctx-c-model)', 'var(--ctx-c-planner)', 'var(--ctx-c-worker)', 'var(--ctx-c-healthy)'];
    $('stats-models-bar').innerHTML =
      models.length > 0 && (t.costUsd || 0) > 0
        ? models
            .map((m, i) => {
              if (!(m.costUsd > 0)) return '';
              const color = palette[i % palette.length];
              return `<div class="stacked-seg" style="width:${Math.max(1, m.costSharePercentage)}%;background:${color}" title="${esc(m.model)}: ${esc(formatCost(m.costUsd))} (${esc(formatPct(m.costSharePercentage))})"></div>`;
            })
            .join('')
        : '';

    $('stats-models-rows').innerHTML =
      models.length === 0
        ? '<div class="empty-sub">No model invocations in range.</div>'
        : models
            .map((m, i) => {
              const color = palette[i % palette.length];
              return `
                <div class="model-item">
                  <div class="model-item-top">
                    <div class="model-item-left">
                      <span class="cat-dot" style="background:${color}"></span>
                      <span class="model-role-name">${esc(m.model)}</span>
                    </div>
                    <span class="model-item-right">${esc(`${m.invocations}t · ${formatCost(m.costUsd)} · ${formatPct(m.costSharePercentage)}`)}</span>
                  </div>
                  <div class="model-item-metrics">
                    <span>In <strong>${esc(formatTokens(m.totalInputTokens))}</strong> (Cache ⚡${esc(formatPct(m.cacheHitRate))})</span>
                    <span>Out <strong>${esc(formatTokens(m.outputTokens))}</strong></span>
                    <span>Saved <strong>${esc(formatCost(m.cacheSavingsUsd))}</strong></span>
                  </div>
                </div>
              `;
            })
            .join('');

    const sessions = stats.topSessions || [];
    if (sessions.length === 0) {
      $('stats-top-sessions').innerHTML = '<div class="empty-sub">No matching sessions in this range.</div>';
    } else {
      $('stats-top-sessions').innerHTML = sessions
        .map(
          (s) => `
            <div class="list-row clickable" data-stat-conv="${esc(s.conversationId)}">
              <div class="list-left">
                <div class="list-title" title="${esc(s.title)}">${esc(s.title)}</div>
                <div class="list-sub">${esc(String(s.product || '').toUpperCase())} · ${esc(s.conversationId.slice(0, 8))} · ${esc(s.model)} · ${esc(s.turnsCount)} turns</div>
              </div>
              <div class="list-right">${esc(formatCost(s.costUsd, true))}</div>
            </div>
          `
        )
        .join('');
      $('stats-top-sessions').querySelectorAll('[data-stat-conv]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.dataset.statConv;
          if (id) selectConversation(id);
        });
      });
    }
  }

  async function pollStats() {
    try {
      const qs = new URLSearchParams({
        period: state.statsPeriod || 'week',
        surface: state.statsSurface || 'all',
        windowSize: String(state.windowSize || 0),
        etag: state.statsEtag || '',
      });
      if (state.statsPeriod === 'custom') {
        if (state.statsFrom) qs.set('from', state.statsFrom);
        if (state.statsTo) qs.set('to', state.statsTo);
      }
      const data = await apiGet(`/api/stats?${qs.toString()}`);
      setLiveStatus(true);
      if (data.etag) state.statsEtag = data.etag;
      if (!data.unchanged) {
        state.statsData = data;
        renderStats(data);
      }
    } catch {
      setLiveStatus(false);
    }
  }

  // Event wiring
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('btn-go-sessions').addEventListener('click', () => switchTab('sessions'));

  $('window-select').addEventListener('change', (e) => {
    state.windowSize = Number(e.target.value) || 0;
    state.contextEtag = '';
    state.listEtag = '';
    state.statsEtag = '';
    pollContext();
    pollConversations();
    if (state.tab === 'stats') pollStats();
  });

  $('sessions-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value || '';
    renderSessionsList();
  });

  $('sessions-sort').addEventListener('change', (e) => {
    state.sortOrder = e.target.value || 'recent';
    renderSessionsList();
  });

  document.querySelectorAll('#panel-sessions .pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#panel-sessions .pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      state.surfaceFilter = pill.dataset.surface || 'all';
      renderSessionsList();
    });
  });

  document.querySelectorAll('#stats-period-pills .pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#stats-period-pills .pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      const nextPeriod = pill.dataset.period || 'week';
      state.statsPeriod = nextPeriod;
      const customBar = $('stats-custom-bar');
      if (nextPeriod === 'custom') {
        customBar.classList.remove('hidden');
        if (!$('stats-from').value) {
          const dFrom = new Date();
          dFrom.setDate(dFrom.getDate() - 6);
          dFrom.setHours(0, 0, 0, 0);
          $('stats-from').value = formatDatetimeLocalValue(dFrom.getTime());
        }
        if (!$('stats-to').value) {
          const dTo = new Date();
          dTo.setHours(23, 59, 0, 0);
          $('stats-to').value = formatDatetimeLocalValue(dTo.getTime());
        }
        state.statsFrom = $('stats-from').value;
        state.statsTo = $('stats-to').value;
      } else {
        customBar.classList.add('hidden');
      }
      state.statsEtag = '';
      pollStats();
    });
  });

  $('btn-stats-apply').addEventListener('click', () => {
    state.statsPeriod = 'custom';
    state.statsFrom = $('stats-from').value || '';
    state.statsTo = $('stats-to').value || '';
    state.statsEtag = '';
    pollStats();
  });

  $('stats-surface').addEventListener('change', (e) => {
    state.statsSurface = e.target.value || 'all';
    state.statsEtag = '';
    pollStats();
  });

  $('btn-sync-pricing').addEventListener('click', async () => {
    const btn = $('btn-sync-pricing');
    const note = $('stats-pricing-note');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const res = await apiPost('/api/pricing/refresh', {});
      if (res.ok) {
        note.textContent = res.notModified
          ? `Up to date (${res.lastModified ? res.lastModified.slice(0, 22) : '304'})`
          : `Synced ${res.modelCount} models`;
        state.contextEtag = '';
        state.listEtag = '';
        state.statsEtag = '';
        pollContext();
        pollConversations();
        pollStats();
      } else {
        note.textContent = `Sync error: ${res.error || 'failed'}`;
      }
    } catch (err) {
      note.textContent = err?.message || 'Sync failed';
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Sync';
    }
  });

  $('btn-compact').addEventListener('click', async () => {
    const btn = $('btn-compact');
    const status = $('compact-status');
    if (!state.compactConfirm) {
      state.compactConfirm = true;
      btn.textContent = 'Click again to send /compact';
      clearTimeout(state.compactTimer);
      state.compactTimer = setTimeout(() => {
        state.compactConfirm = false;
        btn.textContent = 'Send /compact';
      }, 4000);
      return;
    }

    state.compactConfirm = false;
    clearTimeout(state.compactTimer);
    btn.disabled = true;
    status.textContent = 'Sending…';
    try {
      await window.sidecar.agent.sendMessage('/compact', state.convId);
      status.textContent = 'Sent /compact';
      btn.textContent = 'Send /compact';
    } catch (err) {
      status.textContent = err?.message || 'Failed';
      btn.textContent = 'Send /compact';
    } finally {
      btn.disabled = false;
    }
  });

  // Initial load & polling
  switchTab(state.tab);
  pollContext();
  pollConversations();
  setInterval(pollContext, POLL_MS);
  setInterval(pollConversations, LIST_POLL_MS);
  setInterval(() => {
    if (state.tab === 'stats') pollStats();
  }, LIST_POLL_MS);
})();
