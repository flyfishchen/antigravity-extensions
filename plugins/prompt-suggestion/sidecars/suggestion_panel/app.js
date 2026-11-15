(() => {
  const POLL_MS = 1500;
  const LIST_POLL_MS = 3500;

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

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

    const rawContrastSource = getComputedStyle(document.documentElement)
      .getPropertyValue('--muted-foreground')
      .trim();
    let contrastMode = 'fallback';
    if (rawContrastSource) {
      const fgLum = luminanceOfCssColor('var(--muted-foreground)', bgLum);
      if (fgLum !== null && Math.abs(fgLum - bgLum) >= 0.25) {
        contrastMode = 'host';
      }
    }
    if (document.documentElement.dataset.contrastMode !== contrastMode) {
      document.documentElement.dataset.contrastMode = contrastMode;
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

  const state = {
    tab: isGlobalRoute || !hostConvId ? 'sessions' : 'session',
    convId: hostConvId,
    suggestionsEtag: '',
    listEtag: '',
    sessionData: null,
    conversations: [],
    searchQuery: '',
    toastTimer: null,
  };

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, payload) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function setLiveStatus(ok) {
    const pill = $('live-pill');
    const label = $('live-label');
    pill.classList.toggle('stale', !ok);
    label.textContent = ok ? 'Live' : 'Reconnecting';
  }

  function switchTab(nextTab) {
    state.tab = nextTab;
    for (const name of ['session', 'sessions']) {
      const active = name === nextTab;
      $(`tab-btn-${name}`).classList.toggle('active', active);
      $(`tab-btn-${name}`).setAttribute('aria-selected', active ? 'true' : 'false');
      $(`panel-${name}`).classList.toggle('active', active);
      $(`panel-${name}`).classList.toggle('hidden', !active);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied suggestion to clipboard');
      return true;
    } catch {
      showToast('Copy failed — select text manually');
      return false;
    }
  }

  async function sendSuggestion(text, lastStepIndex) {
    const sender = window.sidecar?.agent?.sendMessage;
    if (typeof sender === 'function' && state.convId) {
      try {
        await sender(text, state.convId);
        await apiPost('/api/preferences', {
          conversationId: state.convId,
          action: 'dismiss',
          lastStepIndex,
        });
        state.suggestionsEtag = '';
        await pollSuggestions();
        showToast('Sent follow-up prompt');
        return;
      } catch {
        // Fall through to clipboard fallback if host sendMessage rejects.
      }
    }
    await copyText(text);
  }

  function updateToggleUi(enabled) {
    const btn = $('btn-toggle-enabled');
    const label = $('toggle-label');
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    label.textContent = enabled ? 'Enabled' : 'Disabled';
  }

  function renderSession() {
    const data = state.sessionData;
    $('session-loading').classList.add('hidden');

    if (!data || !data.found) {
      $('session-content').classList.add('hidden');
      $('session-empty').classList.remove('hidden');
      updateToggleUi(data?.preferences?.globalEnabled !== false);
      return;
    }

    $('session-empty').classList.add('hidden');
    $('session-content').classList.remove('hidden');

    const prefs = data.preferences || {};
    const enabled = prefs.enabled !== false;
    const dismissed = Boolean(prefs.dismissed);
    updateToggleUi(enabled);

    $('conv-title').textContent = data.title || 'Untitled conversation';
    $('conv-surface').textContent = (data.product || 'app').toUpperCase();
    $('conv-id').textContent = String(data.conversationId || '').slice(0, 8);

    const statusBadge = $('conv-status-badge');
    if (!enabled) {
      statusBadge.textContent = 'Disabled';
    } else if (dismissed) {
      statusBadge.textContent = 'Dismissed';
    } else if (!data.turnCompleted) {
      statusBadge.textContent = 'Running…';
    } else {
      statusBadge.textContent = 'Ready';
    }

    const dismissRestoreBtn = $('btn-dismiss-restore');
    if (dismissed && data.candidates?.length) {
      dismissRestoreBtn.textContent = 'Restore suggestion';
      dismissRestoreBtn.classList.remove('hidden');
      dismissRestoreBtn.onclick = async () => {
        await apiPost('/api/preferences', { conversationId: state.convId, action: 'restore' });
        state.suggestionsEtag = '';
        await pollSuggestions();
      };
    } else {
      dismissRestoreBtn.classList.add('hidden');
    }

    const listEl = $('suggestions-list');
    const silentEl = $('suggestions-silent');
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];

    if (!enabled) {
      listEl.innerHTML = '';
      silentEl.classList.remove('hidden');
      $('silent-title').textContent = 'Suggestions paused for this session';
      $('silent-sub').textContent = 'Click Enabled in the header or run :s on to resume.';
      return;
    }

    if (!candidates.length || dismissed) {
      listEl.innerHTML = '';
      silentEl.classList.remove('hidden');
      $('silent-title').textContent = dismissed ? 'Dismissed for this turn' : 'Silent for this turn';
      $('silent-sub').textContent = dismissed
        ? 'New suggestions will appear after the next assistant reply.'
        : 'No high-confidence follow-up prompt predicted (silent rather than wrong).';
      return;
    }

    silentEl.classList.add('hidden');
    listEl.innerHTML = candidates
      .map(
        (c, idx) => `
      <article class="card suggestion-card">
        <div class="suggestion-head">
          <span class="rank-pill">#${idx + 1} · ${Math.round((c.confidence || 0) * 100)}%</span>
          <span class="badge reason">${esc(c.reason)}</span>
        </div>
        <p class="suggestion-text">${esc(c.text)}</p>
        <div class="suggestion-actions">
          <button type="button" class="btn primary" data-action="send" data-idx="${idx}">Send ↵</button>
          <button type="button" class="btn" data-action="copy" data-idx="${idx}">Copy</button>
          ${
            idx === 0
              ? '<button type="button" class="btn" data-action="dismiss">Dismiss</button>'
              : ''
          }
        </div>
      </article>`
      )
      .join('');

    listEl.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const idx = Number(btn.dataset.idx);
        const item = candidates[idx];
        if (action === 'send' && item) {
          await sendSuggestion(item.text, data.lastStepIndex);
        } else if (action === 'copy' && item) {
          await copyText(item.text);
        } else if (action === 'dismiss') {
          await apiPost('/api/preferences', {
            conversationId: state.convId,
            action: 'dismiss',
            lastStepIndex: data.lastStepIndex,
          });
          state.suggestionsEtag = '';
          await pollSuggestions();
        }
      });
    });
  }

  function renderConversations() {
    const q = state.searchQuery.trim().toLowerCase();
    const filtered = state.conversations.filter((c) => {
      if (!q) return true;
      return (
        String(c.title || '').toLowerCase().includes(q) ||
        String(c.topSuggestion || '').toLowerCase().includes(q) ||
        String(c.conversationId || '').toLowerCase().includes(q)
      );
    });

    $('sessions-count').textContent = String(state.conversations.length);
    $('sessions-count').classList.toggle('hidden', state.conversations.length === 0);

    const listEl = $('sessions-list');
    if (!filtered.length) {
      listEl.innerHTML =
        '<div class="card empty-card"><div class="empty-title">No matching conversations</div></div>';
      return;
    }

    listEl.innerHTML = filtered
      .map(
        (c) => `
      <button type="button" class="card session-row" data-conv="${esc(c.conversationId)}">
        <div class="meta-top">
          <div class="conv-title">${esc(c.title)}</div>
          <span class="badge surface">${esc((c.product || 'app').toUpperCase())}</span>
        </div>
        <div class="session-row-preview">${
          c.topSuggestion ? `⇢ ${esc(c.topSuggestion)}` : '— silent / no suggestion'
        }</div>
      </button>`
      )
      .join('');

    listEl.querySelectorAll('button[data-conv]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.convId = btn.dataset.conv || '';
        state.suggestionsEtag = '';
        switchTab('session');
        pollSuggestions();
      });
    });
  }

  async function pollSuggestions() {
    try {
      const qs = new URLSearchParams();
      if (state.convId) qs.set('conversationId', state.convId);
      else qs.set('fallback', 'latest');
      if (state.suggestionsEtag) qs.set('etag', state.suggestionsEtag);

      const res = await apiGet(`/api/suggestions?${qs.toString()}`);
      setLiveStatus(true);
      if (res.unchanged) return;
      state.suggestionsEtag = res.etag || '';
      if (!state.convId && res.conversationId) state.convId = res.conversationId;
      state.sessionData = res;
      renderSession();
    } catch {
      setLiveStatus(false);
    }
  }

  async function pollConversations() {
    try {
      const qs = new URLSearchParams({ limit: '30' });
      if (state.listEtag) qs.set('etag', state.listEtag);
      const res = await apiGet(`/api/conversations?${qs.toString()}`);
      setLiveStatus(true);
      if (res.unchanged) return;
      state.listEtag = res.etag || '';
      state.conversations = Array.isArray(res.conversations) ? res.conversations : [];
      renderConversations();
    } catch {
      setLiveStatus(false);
    }
  }

  $('tab-btn-session').addEventListener('click', () => {
    switchTab('session');
    pollSuggestions();
  });
  $('tab-btn-sessions').addEventListener('click', () => {
    switchTab('sessions');
    pollConversations();
  });
  $('btn-go-sessions').addEventListener('click', () => {
    switchTab('sessions');
    pollConversations();
  });
  $('sessions-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value || '';
    renderConversations();
  });
  $('btn-toggle-enabled').addEventListener('click', async () => {
    await apiPost('/api/preferences', {
      conversationId: state.convId,
      action: 'toggle',
    });
    state.suggestionsEtag = '';
    await pollSuggestions();
  });

  switchTab(state.tab);
  pollSuggestions();
  pollConversations();
  setInterval(pollSuggestions, POLL_MS);
  setInterval(pollConversations, LIST_POLL_MS);
})();
