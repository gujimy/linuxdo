// ==UserScript==
// @name         Linux.do 
// @namespace    https://linux.do/
// @version      1.1.0
// @description  等级 + LDC
// @author       code01
// @match        https://linux.do/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      connect.linux.do
// @connect      credit.linux.do
// @connect      linux.do
// @downloadURL  https://raw.githubusercontent.com/gujimy/linuxdo/main/linuxdo.user.js
// @updateURL    https://raw.githubusercontent.com/gujimy/linuxdo/main/linuxdo.user.js
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';
  let refreshTimer = null;
  let routeWatcherStarted = false;
  let lastHref = location.href;
  const TAB_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const THROTTLE = {
    BASE_INTERVAL_MS: 5 * 60 * 1000,
    MIN_INTERVAL_MS: 60 * 1000,
    MANUAL_MIN_INTERVAL_MS: 3 * 1000,
    MAX_BACKOFF_MS: 40 * 60 * 1000,
    CREDIT_401_PAUSE_MS: 20 * 60 * 1000,
    CROSS_TAB_LOCK_MS: 20 * 1000,
    SAME_ORIGIN_TIMEOUT_MS: 15000,
  };

  function isLinuxdoPage() {
    return location.hostname === 'linux.do';
  }

  const API = {
    TRUST_CONNECT: 'https://connect.linux.do/',
    CREDIT_INFO: 'https://credit.linux.do/api/v1/oauth/user-info',
    CREDIT_STATS: 'https://credit.linux.do/api/v1/dashboard/stats/daily?days=7',
    USER_INFO: (username) => `https://linux.do/u/${username}.json`,
    USER_SUMMARY: (username) => `https://linux.do/u/${username}/summary.json`,
  };

  const KEYS = {
    PANEL_OPEN: 'ldm_tw_open',
    LAST_DATA: 'ldm_tw_data',
    FAB_POS: 'ldm_tw_fab_pos',
    SECTION_STATE: 'ldm_tw_section_state',
    PANEL_SIZE: 'ldm_tw_panel_size',
    PANEL_SIZE_MIGRATED: 'ldm_tw_panel_size_migrated',
    THROTTLE_STATE: 'ldm_tw_throttle_state',
  };

  const LOW_LEVEL_REQUIREMENTS = {
    0: {
      topics_entered: { name: '浏览的话题', target: 5 },
      posts_read_count: { name: '已读帖子', target: 30 },
      time_read: { name: '阅读时间', target: 600, unit: 'seconds' },
    },
    1: {
      days_visited: { name: '访问天数', target: 15 },
      likes_given: { name: '送出赞', target: 1 },
      likes_received: { name: '获赞', target: 1 },
      post_count: { name: '帖子数量', target: 3 },
      topics_entered: { name: '浏览的话题', target: 20 },
      posts_read_count: { name: '已读帖子', target: 100 },
      time_read: { name: '阅读时间', target: 3600, unit: 'seconds' },
    },
  };

  const state = {
    loading: false,
    trust: null,
    credit: null,
    error: '',
    lastRequestAt: 0,
  };

  const uiState = {
    draggingFab: false,
    fabPos: null,
    scheduleDockLayout: null,
    sections: { trust: true, credit: true },
  };

  function gGet(key, fallback) {
    try {
      const v = GM_getValue(key);
      return v === undefined ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function gSet(key, value) {
    try {
      GM_setValue(key, value);
    } catch (_) {
      // ignore
    }
  }

  function ensureTailwindLoaded() {
    // 保留接口以减少改动；当前改为纯 CSS，不再注入 Tailwind
    return Promise.resolve();
  }

  function readThrottleState() {
    const raw = gGet(KEYS.THROTTLE_STATE, null);
    const legacyNextAllowedAt = Number(raw?.nextAllowedAt || 0);
    const legacyFailCount = Number(raw?.failCount || 0);
    const legacyCreditPausedUntil = Number(raw?.creditPausedUntil || 0);
    return {
      lockUntil: Number(raw?.lockUntil || 0),
      lockBy: String(raw?.lockBy || ''),
      lockToken: String(raw?.lockToken || ''),
      trust: {
        nextAllowedAt: Number(raw?.trust?.nextAllowedAt ?? legacyNextAllowedAt ?? 0),
        failCount: Number(raw?.trust?.failCount ?? legacyFailCount ?? 0),
      },
      credit: {
        nextAllowedAt: Number(raw?.credit?.nextAllowedAt ?? legacyNextAllowedAt ?? 0),
        failCount: Number(raw?.credit?.failCount ?? legacyFailCount ?? 0),
        pausedUntil: Number(raw?.credit?.pausedUntil ?? legacyCreditPausedUntil ?? 0),
      },
    };
  }

  function writeThrottleState(nextState) {
    gSet(KEYS.THROTTLE_STATE, nextState);
    return nextState;
  }

  function mergeThrottleState(patch) {
    const curr = readThrottleState();
    return writeThrottleState({
      ...curr,
      ...(patch || {}),
      trust: {
        ...curr.trust,
        ...(patch?.trust || {}),
      },
      credit: {
        ...curr.credit,
        ...(patch?.credit || {}),
      },
    });
  }

  function computeBackoffMs(failCount) {
    if (failCount <= 0) return THROTTLE.BASE_INTERVAL_MS;
    const exp = Math.max(0, failCount - 1);
    return Math.min(THROTTLE.BASE_INTERVAL_MS * (2 ** exp), THROTTLE.MAX_BACKOFF_MS);
  }

  function tryAcquireCrossTabLock() {
    const now = Date.now();
    const curr = readThrottleState();
    if (curr.lockUntil > now && curr.lockBy && curr.lockBy !== TAB_ID) {
      return null;
    }
    const lockToken = `${TAB_ID}_${now}_${Math.random().toString(36).slice(2, 8)}`;
    writeThrottleState({
      ...curr,
      lockUntil: now + THROTTLE.CROSS_TAB_LOCK_MS,
      lockBy: TAB_ID,
      lockToken,
    });
    const latest = readThrottleState();
    return latest.lockBy === TAB_ID && latest.lockToken === lockToken && latest.lockUntil > now
      ? lockToken
      : null;
  }

  function releaseCrossTabLock(lockToken) {
    const curr = readThrottleState();
    if (curr.lockBy !== TAB_ID || curr.lockToken !== lockToken) return;
    writeThrottleState({
      ...curr,
      lockUntil: 0,
      lockBy: '',
      lockToken: '',
    });
  }

  function formatClockTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function updateSourceSuccess(source) {
    const now = Date.now();
    if (source === 'trust') {
      mergeThrottleState({
        trust: { failCount: 0, nextAllowedAt: now + THROTTLE.BASE_INTERVAL_MS },
      });
      return;
    }
    mergeThrottleState({
      credit: { failCount: 0, nextAllowedAt: now + THROTTLE.BASE_INTERVAL_MS, pausedUntil: 0 },
    });
  }

  function updateSourceFailure(source) {
    const curr = readThrottleState();
    const sourceState = curr[source];
    const nextFailCount = Number(sourceState?.failCount || 0) + 1;
    const nextAllowedAt = Date.now() + computeBackoffMs(nextFailCount);
    if (source === 'trust') {
      mergeThrottleState({
        trust: { failCount: nextFailCount, nextAllowedAt },
      });
      return;
    }
    mergeThrottleState({
      credit: { failCount: nextFailCount, nextAllowedAt },
    });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatReadTime(seconds) {
    const s = Number(seconds) || 0;
    if (s < 60) return `${s}秒`;
    const mins = Math.floor(s / 60);
    if (mins < 60) return `${mins}分钟`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}小时${m}分` : `${h}小时`;
  }

  function getTodayDateString() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function gmRequest(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: opts.timeout || 15000,
        withCredentials: true,
        headers: opts.headers || {},
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            resolve(r.responseText);
          } else {
            const err = new Error(`HTTP ${r.status}`);
            err.status = r.status;
            err.responseText = r.responseText;
            reject(err);
          }
        },
        onerror: reject,
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  async function requestJSON(url, opts = {}) {
    const sameOrigin = url.startsWith(location.origin);
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    const headers = {
      Accept: 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(opts.headers || {}),
    };

    if (sameOrigin) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeout || THROTTLE.SAME_ORIGIN_TIMEOUT_MS);
      const r = await fetch(url, { credentials: 'include', headers, signal: controller.signal })
        .finally(() => clearTimeout(timeoutId));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }

    const text = await gmRequest(url, { headers });
    return JSON.parse(text);
  }

  async function fetchCurrentUsername() {
    try {
      const s = await requestJSON(`${location.origin}/session/current.json`);
      const name = s?.current_user?.username;
      if (name) return String(name).trim();
    } catch (_) {}

    try {
      const name = window?.Discourse?.User?.current?.()?.username;
      if (name) return String(name).trim();
    } catch (_) {}

    return null;
  }

  function parseConnectCard(doc) {
    const card = Array.from(doc.querySelectorAll('div.card')).find((div) => {
      const h2 = div.querySelector('h2.card-title');
      return h2 && /信任级别/.test(h2.textContent || '') && /的要求/.test(h2.textContent || '');
    });
    if (!card) return null;

    const h2 = card.querySelector('h2.card-title');
    const titleMatch = (h2?.textContent || '').match(/信任级别\s*(\d+)\s*的要求/);
    const targetLevel = titleMatch ? parseInt(titleMatch[1], 10) : null;
    const badge = card.querySelector('.card-header .badge');
    const isAchieved = !!(badge && badge.classList.contains('badge-success'));
    const level = targetLevel == null ? null : (isAchieved ? targetLevel : targetLevel - 1);

    const items = [];
    let allPassed = true;

    const pushItem = (name, current, target, isGood) => {
      const currentNum = Number(current) || 0;
      const targetNum = Number(target) || 0;
      const pct = targetNum > 0 ? Math.min((currentNum / targetNum) * 100, 100) : (isGood ? 100 : 0);
      if (!isGood) allPassed = false;
      items.push({ name, current: currentNum, target: targetNum, pct, isGood });
    };

    card.querySelectorAll('.tl3-ring').forEach((ring) => {
      const name = ring.querySelector('.tl3-ring-label')?.textContent?.trim();
      const currentText = ring.querySelector('.tl3-ring-current')?.textContent?.trim();
      const targetText = ring.querySelector('.tl3-ring-target')?.textContent?.replace(/^[\s/]+/, '').trim();
      const isGood = ring.querySelector('.tl3-ring-circle')?.classList.contains('met') || false;
      if (!name || !currentText) return;
      pushItem(name, parseFloat(currentText.replace(/,/g, '')) || 0, parseFloat((targetText || '0').replace(/,/g, '')) || 0, isGood);
    });

    card.querySelectorAll('.tl3-bar-item').forEach((bar) => {
      const name = bar.querySelector('.tl3-bar-label')?.textContent?.trim();
      const nums = bar.querySelector('.tl3-bar-nums')?.textContent?.trim();
      if (!name || !nums) return;
      const parts = nums.split('/');
      const cur = parseFloat((parts[0] || '0').replace(/,/g, '').trim()) || 0;
      const tar = parseFloat((parts[1] || '0').replace(/,/g, '').trim()) || 0;
      const isGood = bar.querySelector('.tl3-bar-nums')?.classList.contains('met') || false;
      pushItem(name, cur, tar, isGood);
    });

    card.querySelectorAll('.tl3-quota-card').forEach((quota) => {
      const name = quota.querySelector('.tl3-quota-label')?.textContent?.trim();
      const nums = quota.querySelector('.tl3-quota-nums')?.textContent?.trim();
      if (!name || !nums) return;
      const parts = nums.split('/');
      const cur = parseFloat((parts[0] || '0').replace(/,/g, '').trim()) || 0;
      const tar = parseFloat((parts[1] || '0').replace(/,/g, '').trim()) || 0;
      const isGood = quota.classList.contains('met');
      pushItem(name, cur, tar, isGood);
    });

    // 否决项：通常目标值为 0（例如近100天封禁次数）
    card.querySelectorAll('.tl3-veto-item').forEach((veto) => {
      const name = veto.querySelector('.tl3-veto-label')?.textContent?.trim();
      const valueText = veto.querySelector('.tl3-veto-value')?.textContent?.trim();
      if (!name || !valueText) return;
      const cur = parseFloat(valueText.replace(/,/g, '').trim()) || 0;
      const isGood = veto.classList.contains('met');
      pushItem(name, cur, 0, isGood);
    });

    if (!items.length) return null;

    return {
      level,
      isPass: allPassed,
      items,
    };
  }

  async function fetchTrustData() {
    try {
      const html = await gmRequest(API.TRUST_CONNECT, {
        headers: { Referer: 'https://connect.linux.do/' },
      });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const loginHint = doc.querySelector('a[href*="/login"], form[action*="/login"], form[action*="/session"]');
      if (!loginHint) {
        const parsed = parseConnectCard(doc);
        if (parsed) {
          return {
            source: 'connect',
            ...parsed,
          };
        }
      }
    } catch (_) {
      // fallback
    }

    const username = await fetchCurrentUsername();
    if (!username) throw new Error('未登录 Linux.do');

    const [userInfo, summary] = await Promise.all([
      requestJSON(API.USER_INFO(username)),
      requestJSON(API.USER_SUMMARY(username)),
    ]);

    const level = Number(userInfo?.user?.trust_level ?? 0);
    const reqs = LOW_LEVEL_REQUIREMENTS[level];

    if (!reqs || !summary?.user_summary) {
      return {
        source: 'summary',
        level,
        isPass: false,
        items: [{ name: '信任基础', current: level, target: 3, pct: Math.min((level / 3) * 100, 100), isGood: level >= 2 }],
      };
    }

    const s = summary.user_summary;
    const items = [];
    let allPassed = true;

    Object.entries(reqs).forEach(([key, cfg]) => {
      const currentRaw = Number(s[key] || 0);
      const targetRaw = Number(cfg.target || 0);
      const isGood = currentRaw >= targetRaw;
      if (!isGood) allPassed = false;

      const currentDisplay = cfg.unit === 'seconds' ? formatReadTime(currentRaw) : currentRaw;
      const targetDisplay = cfg.unit === 'seconds' ? formatReadTime(targetRaw) : targetRaw;

      items.push({
        name: cfg.name,
        current: currentDisplay,
        target: targetDisplay,
        pct: targetRaw > 0 ? Math.min((currentRaw / targetRaw) * 100, 100) : 0,
        isGood,
      });
    });

    return {
      source: 'summary',
      level,
      isPass: allPassed,
      items,
    };
  }

  async function fetchCreditData() {
    const [infoRes, statsRes] = await Promise.all([
      requestJSON(API.CREDIT_INFO, { headers: { Referer: 'https://credit.linux.do/home' } }),
      requestJSON(API.CREDIT_STATS, { headers: { Referer: 'https://credit.linux.do/home' } }),
    ]);

    const info = infoRes?.data;
    const stats = Array.isArray(statsRes?.data) ? statsRes.data : [];

    if (!info) {
      throw new Error('Credit 未授权或未登录');
    }

    const username = info.username || info.nickname || null;
    let gamificationScore = null;

    if (username) {
      try {
        const userRes = await requestJSON(API.USER_INFO(username));
        gamificationScore = Number(userRes?.user?.gamification_score ?? null);
      } catch (_) {
        gamificationScore = null;
      }
    }

    const communityBalance = Number(info['community-balance'] ?? info.community_balance ?? 0);
    const estimatedGain = gamificationScore === null || Number.isNaN(gamificationScore)
      ? null
      : gamificationScore - communityBalance;

    let weekIncome = 0;
    let weekExpense = 0;
    stats.forEach((d) => {
      weekIncome += Number(d.income || 0);
      weekExpense += Number(d.expense || 0);
    });

    const todayStr = getTodayDateString();
    let todayRow = stats.find((d) => String(d?.date || '').slice(0, 10) === todayStr) || null;
    if (!todayRow && stats.length) {
      todayRow = [...stats].sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || ''))).pop();
    }
    const todayIncome = Number(todayRow?.income || 0);
    const todayExpense = Number(todayRow?.expense || 0);
    const todayGain = todayRow ? (todayIncome - todayExpense) : null;
    return {
      info,
      stats,
      estimatedGain,
      gamificationScore,
      communityBalance,
      weekIncome,
      weekExpense,
      weekNet: weekIncome - weekExpense,
      todayGain,
    };
  }

  function renderTrustCard(trust) {
    if (!trust) {
      return '<div class="ldm-empty">暂无信任数据</div>';
    }

    const statusTag = trust.isPass
      ? '<span class="ldm-pill ldm-pill-ok">已达标</span>'
      : '<span class="ldm-pill ldm-pill-bad">未达标</span>';

    const connectLink = '<a href="https://connect.linux.do/" target="_blank" rel="noopener noreferrer" class="ldm-pill ldm-pill-link">Connect</a>';

    const rows = trust.items.slice(0, 8).map((it) => {
      const pct = Math.max(0, Math.min(100, Number(it.pct || 0)));
      return `
        <div class="ldm-item">
          <div class="ldm-item-top">
            <span class="ldm-item-name">${escapeHtml(it.name)}</span>
            <span class="ldm-item-val ${it.isGood ? 'ldm-ok' : 'ldm-bad'}">${escapeHtml(it.current)} / ${escapeHtml(it.target)}</span>
          </div>
          <div class="ldm-progress">
            <div class="ldm-progress-fill ${it.isGood ? 'ldm-progress-ok' : 'ldm-progress-bad'}" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');

    const expanded = !!uiState.sections.trust;
    const arrow = expanded ? '▾' : '▸';

    return `
        <div class="ldm-block">
          <div class="ldm-block-head">
            <div class="ldm-block-title">等级</div>
            <div class="ldm-head-actions">
              <button id="ldm-refresh-trust" class="ldm-refresh-mini" title="刷新 等级">↻</button>
              ${connectLink}
              <button id="ldm-toggle-trust" class="ldm-toggle-btn">${arrow}</button>
            </div>
          </div>
        <div class="${expanded ? 'ldm-show' : 'ldm-hide'}">
          <div class="ldm-level-row">
            <div class="ldm-level">Lv.${escapeHtml(trust.level ?? '--')}</div>
            ${statusTag}
          </div>
          <div>${rows || '<div class="ldm-empty">暂无条目</div>'}</div>
        </div>
      </div>
    `;
  }

  function renderCreditCard(credit) {
    if (!credit?.info) {
      const expanded = !!uiState.sections.credit;
      const arrow = expanded ? '▾' : '▸';
      return `
        <div class="ldm-block">
          <div class="ldm-block-head">
            <div class="ldm-block-title">LDC</div>
            <div class="ldm-head-actions">
              <button id="ldm-refresh-credit" class="ldm-refresh-mini" title="刷新 LDC">↻</button>
              <a href="https://credit.linux.do/home" target="_blank" rel="noopener noreferrer" class="ldm-pill ldm-pill-link">Credit</a>
              <button id="ldm-toggle-credit" class="ldm-toggle-btn">${arrow}</button>
            </div>
          </div>
          <div class="${expanded ? 'ldm-show' : 'ldm-hide'}">
            <div class="ldm-empty">暂无积分数据，请点击 Credit 登录后重试</div>
          </div>
        </div>
      `;
    }

    const gainClass = credit.estimatedGain === null
      ? 'ldm-muted'
      : credit.estimatedGain >= 0 ? 'ldm-ok' : 'ldm-bad';

    const gainText = credit.estimatedGain === null
      ? '--'
      : `${credit.estimatedGain >= 0 ? '+' : ''}${credit.estimatedGain.toFixed(2)}`;

    const expanded = !!uiState.sections.credit;
    const arrow = expanded ? '▾' : '▸';

    const recentRows = [...credit.stats].slice(-5).reverse().map((d) => {
      const date = String(d.date || '').slice(5).replace('-', '/');
      const inc = Number(d.income || 0).toFixed(2);
      const exp = Number(d.expense || 0).toFixed(2);
      return `
        <div class="ldm-row">
          <span class="ldm-muted">${escapeHtml(date)}</span>
          <span>+${inc} / -${exp}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="ldm-block">
        <div class="ldm-block-head">
          <div class="ldm-block-title">LDC</div>
          <div class="ldm-head-actions">
            <button id="ldm-refresh-credit" class="ldm-refresh-mini" title="刷新 LDC">↻</button>
            <a href="https://credit.linux.do/home" target="_blank" rel="noopener noreferrer" class="ldm-pill ldm-pill-link">Credit</a>
            <button id="ldm-toggle-credit" class="ldm-toggle-btn">${arrow}</button>
          </div>
        </div>
        <div class="${expanded ? 'ldm-show' : 'ldm-hide'}">
          <div class="ldm-stats-grid">
            <div class="ldm-stat">
              <div class="ldm-stat-label">余额</div>
              <div class="ldm-stat-value">${escapeHtml(credit.info.available_balance)}</div>
            </div>
            <div class="ldm-stat">
              <div class="ldm-stat-label">今日额度</div>
              <div class="ldm-stat-value">${escapeHtml(credit.info.remain_quota)}</div>
            </div>
            <div class="ldm-stat span-2">
              <div class="ldm-stat-label">预估涨分</div>
              <div class="ldm-stat-value ${gainClass}">${gainText}</div>
            </div>
          </div>

          <div class="ldm-summary-box">
            <div class="ldm-row">
              <span class="ldm-muted">近7日收入</span><span class="ldm-ok">+${credit.weekIncome.toFixed(2)}</span>
            </div>
            <div class="ldm-row">
              <span class="ldm-muted">近7日支出</span><span class="ldm-bad">-${credit.weekExpense.toFixed(2)}</span>
            </div>
            <div class="ldm-row">
              <span class="ldm-row-key">净变化</span><span class="${credit.weekNet >= 0 ? 'ldm-ok' : 'ldm-bad'}">${credit.weekNet >= 0 ? '+' : ''}${credit.weekNet.toFixed(2)}</span>
            </div>
          </div>

          <div class="ldm-list">
            ${recentRows || '<div class="ldm-empty">暂无近7日记录</div>'}
          </div>
        </div>
      </div>
    `;
  }

  function ensureUI() {
    if (document.getElementById('ldm-tw-root')) return;

    GM_addStyle(`
      #ldm-tw-root { all: initial; }
      #ldm-tw-root, #ldm-tw-root * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      #ldm-tw-root .ldm-hide { display: none; }
      #ldm-tw-root .ldm-show { display: block; }
      #ldm-tw-root .ldm-muted { color: #6b7280; }
      #ldm-tw-root .ldm-ok { color: #0f9d58; font-weight: 700; }
      #ldm-tw-root .ldm-bad { color: #d93025; font-weight: 700; }
      #ldm-tw-root .ldm-empty { color: #6b7280; font-size: 12px; line-height: 1.45; }
      #ldm-tw-root .ldm-spin { animation: ldm-spin 0.8s linear infinite; }
      #ldm-tw-root .ldm-refresh-mini { width: 24px; height: 24px; border: 1px solid rgba(209,213,219,.9); border-radius: 8px; background: rgba(255,255,255,.95); color: #4b5563; cursor: pointer; font-weight: 800; display:inline-flex; align-items:center; justify-content:center; font-size:11px; line-height:1; transition: background-color .18s ease, border-color .18s ease, color .18s ease; }
      #ldm-tw-root .ldm-refresh-mini:hover { background: #f9fafb; border-color: #cbd5e1; color: #111827; }
      #ldm-tw-root .ldm-refresh-mini:disabled { opacity: 0.6; cursor: not-allowed; }
      #ldm-tw-root .ldm-card { border: 1px solid rgba(229,231,235,.95); border-radius: 12px; background: rgba(255,255,255,.94); padding: 7px 8px; box-shadow: 0 1px 6px rgba(17,24,39,.04); }
      #ldm-tw-root .ldm-block { display:flex; flex-direction:column; gap: 5px; }
      #ldm-tw-root .ldm-block-head { display:flex; align-items:center; justify-content:space-between; }
      #ldm-tw-root .ldm-block-title { font-size: 11px; letter-spacing: .02em; color:#6b7280; font-weight: 700; }
      #ldm-tw-root .ldm-head-actions { display:flex; align-items:center; gap:6px; }
      #ldm-tw-root .ldm-pill { font-size: 11px; border-radius: 999px; padding: 3px 7px; text-decoration:none; border: 1px solid transparent; white-space: nowrap; }
      #ldm-tw-root .ldm-pill-ok { background:#e7f7ec; color:#0f9d58; }
      #ldm-tw-root .ldm-pill-bad { background:#fdecec; color:#d93025; }
      #ldm-tw-root .ldm-pill-link { background:#f3f4f6; color:#374151; border-color: #e5e7eb; }
      #ldm-tw-root .ldm-toggle-btn { width: 24px; height:24px; border-radius:8px; border:1px solid rgba(209,213,219,.9); background:#fff; color:#6b7280; cursor:pointer; font-size:12px; font-weight:700; line-height:1; transition: background-color .18s ease, border-color .18s ease, color .18s ease; }
      #ldm-tw-root .ldm-toggle-btn:hover { background:#f9fafb; border-color:#cbd5e1; color:#111827; }
      #ldm-tw-root .ldm-level-row { display:flex; align-items:center; gap:6px; margin-bottom:4px; flex-wrap: wrap; }
      #ldm-tw-root .ldm-level { font-size: 17px; line-height: 1.05; font-weight: 800; color:#111827; }
      #ldm-tw-root .ldm-item { margin-bottom: 5px; }
      #ldm-tw-root .ldm-item-top { display:flex; flex-direction:row; align-items:flex-start; justify-content:space-between; font-size:11px; margin-bottom:2px; gap:6px; }
      #ldm-tw-root .ldm-item-name { color:#4b5563; }
      #ldm-tw-root .ldm-item-val { font-weight:700; line-height:1.2; text-align:right; word-break: break-word; }
      #ldm-tw-root .ldm-progress { height: 4px; border-radius:999px; background:#e5e7eb; overflow:hidden; }
      #ldm-tw-root .ldm-progress-fill { height:100%; }
      #ldm-tw-root .ldm-progress-ok { background:#0f9d58; }
      #ldm-tw-root .ldm-progress-bad { background:#d93025; }
      #ldm-tw-root .ldm-stats-grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:4px; margin-bottom:5px; }
      #ldm-tw-root .ldm-stat { background:#f9fafb; border: 1px solid rgba(229,231,235,.95); border-radius:10px; padding:5px 6px; }
      #ldm-tw-root .ldm-stat.span-2 { grid-column: span 2; }
      #ldm-tw-root .ldm-stat-label { font-size:11px; color:#64748b; }
      #ldm-tw-root .ldm-stat-value { font-size:13px; line-height:1.15; font-weight:800; color:#111827; margin-top:2px; white-space:normal; word-break: break-word; }
      #ldm-tw-root .ldm-summary-box { background: #f9fafb; border: 1px solid rgba(229,231,235,.95); border-radius: 12px; padding: 6px 7px; font-size: 12px; margin-bottom:5px; }
      #ldm-tw-root .ldm-row { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; font-size:11px; line-height:1.25; }
      #ldm-tw-root .ldm-row + .ldm-row { margin-top:2px; }
      #ldm-tw-root .ldm-row-key { color:#374151; font-weight:700; }
      #ldm-tw-root .ldm-list { display:flex; flex-direction:column; gap:4px; }
      #ldm-tw-root #ldm-panel {
        resize: none;
        min-width: 152px;
        max-width: 220px;
        gap: 5px;
      }
      @keyframes ldm-spin { to { transform: rotate(360deg); } }
    `);

    const root = document.createElement('div');
      root.id = 'ldm-tw-root';
      root.innerHTML = `
      <div id="ldm-fab-wrap" style="position:fixed;z-index:99999;">
        <button id="ldm-fab" style="width:40px;height:40px;border-radius:12px;box-shadow:0 4px 12px rgba(17,24,39,.08);background:rgba(255,255,255,.96);color:#0f9d58;font-size:12px;font-weight:800;border:1px solid rgba(229,231,235,.95);cursor:pointer;letter-spacing:.1px;">
          +0
        </button>
      </div>

      <div id="ldm-panel" style="position:fixed;z-index:99998;width:176px;max-width:220px;border-radius:0;border:none;background:transparent;backdrop-filter:none;box-shadow:none;overflow:visible;display:none;flex-direction:column;">
        <section class="ldm-card" id="ldm-trust-card"></section>
        <section class="ldm-card" id="ldm-credit-card"></section>
        <div id="ldm-msg" class="ldm-empty" style="display:none;color:#e11d48;"></div>
      </div>
    `;

    document.body.appendChild(root);

    const panel = root.querySelector('#ldm-panel');
    const fabWrap = root.querySelector('#ldm-fab-wrap');
    const fab = root.querySelector('#ldm-fab');

    const PANEL_FIXED_WIDTH = 167;
    const PANEL_FIXED_LEFT = 0;
    const PANEL_FIXED_TOP = 76;

    uiState.fabPos = gGet(KEYS.FAB_POS, null);

    const clampFabPosition = (leftPx, topPx) => {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 900;
      return {
        left: Math.max(0, Math.min(vw - 40, Math.round(Number(leftPx) || 0))),
        top: Math.max(12, Math.min(vh - 52, Math.round(Number(topPx) || 12))),
      };
    };

    const applyDockLayout = () => {
      const vw = window.innerWidth || 1280;
      panel.style.width = `${PANEL_FIXED_WIDTH}px`;
      panel.style.left = `${PANEL_FIXED_LEFT}px`;
      panel.style.top = `${PANEL_FIXED_TOP}px`;
      panel.style.bottom = 'auto';
      panel.style.height = 'auto';
      panel.style.maxHeight = 'none';

      const defaultFabPos = clampFabPosition(PANEL_FIXED_LEFT, PANEL_FIXED_TOP - 48);
      const nextFabPos = uiState.fabPos && typeof uiState.fabPos === 'object'
        ? clampFabPosition(uiState.fabPos.left, uiState.fabPos.top)
        : defaultFabPos;

      uiState.fabPos = nextFabPos;
      fabWrap.style.left = `${nextFabPos.left}px`;
      fabWrap.style.top = `${nextFabPos.top}px`;
      fabWrap.style.bottom = 'auto';
    };

    let dockLayoutRaf1 = 0;
    let dockLayoutRaf2 = 0;
    let dockLayoutTimer1 = 0;
    let dockLayoutTimer2 = 0;

    const clearDockLayoutSchedule = () => {
      if (dockLayoutRaf1) cancelAnimationFrame(dockLayoutRaf1);
      if (dockLayoutRaf2) cancelAnimationFrame(dockLayoutRaf2);
      if (dockLayoutTimer1) clearTimeout(dockLayoutTimer1);
      if (dockLayoutTimer2) clearTimeout(dockLayoutTimer2);
      dockLayoutRaf1 = 0;
      dockLayoutRaf2 = 0;
      dockLayoutTimer1 = 0;
      dockLayoutTimer2 = 0;
    };

    const scheduleDockLayout = () => {
      clearDockLayoutSchedule();
      applyDockLayout();
      dockLayoutRaf1 = requestAnimationFrame(() => {
        applyDockLayout();
        dockLayoutRaf2 = requestAnimationFrame(() => {
          applyDockLayout();
        });
      });
      dockLayoutTimer1 = setTimeout(() => {
        applyDockLayout();
      }, 140);
      dockLayoutTimer2 = setTimeout(() => {
        applyDockLayout();
      }, 360);
    };

    uiState.scheduleDockLayout = scheduleDockLayout;

    applyDockLayout();

    const isOpen = !!gGet(KEYS.PANEL_OPEN, false);
    if (isOpen) {
      panel.style.display = 'flex';
      requestAnimationFrame(() => {
        scheduleDockLayout();
      });
    }
    const sectionState = gGet(KEYS.SECTION_STATE, { trust: true, credit: true });
    uiState.sections = {
      trust: sectionState?.trust !== false,
      credit: sectionState?.credit !== false,
    };

    fab.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();

      uiState.draggingFab = false;
      const startX = e.clientX;
      const startY = e.clientY;
      const currentLeft = parseFloat(fabWrap.style.left) || 0;
      const currentTop = parseFloat(fabWrap.style.top) || 12;
      const pointerId = e.pointerId;
      let cleanedUp = false;

      const onMove = (ev) => {
        if (ev.pointerId !== pointerId) return;
        if (Math.abs(ev.clientX - startX) < 8 && Math.abs(ev.clientY - startY) < 8) return;
        uiState.draggingFab = true;
        uiState.fabPos = clampFabPosition(
          currentLeft + (ev.clientX - startX),
          currentTop + (ev.clientY - startY),
        );
        fabWrap.style.left = `${uiState.fabPos.left}px`;
        fabWrap.style.top = `${uiState.fabPos.top}px`;
      };

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onCancel);
      };

      const onUp = (ev) => {
        if (ev.pointerId !== pointerId) return;
        cleanup();

        if (uiState.draggingFab) {
          uiState.fabPos = clampFabPosition(
            currentLeft + (ev.clientX - startX),
            currentTop + (ev.clientY - startY),
          );
          gSet(KEYS.FAB_POS, uiState.fabPos);
        }

        setTimeout(() => {
          uiState.draggingFab = false;
        }, 0);
      };

      const onCancel = () => {
        cleanup();
        uiState.draggingFab = false;
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
      window.addEventListener('blur', onCancel);
    });

    fab.addEventListener('click', () => {
      if (uiState.draggingFab) return;
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      gSet(KEYS.PANEL_OPEN, panel.style.display !== 'none');
      requestAnimationFrame(() => {
        scheduleDockLayout();
      });
    });

    window.addEventListener('resize', () => {
      scheduleDockLayout();
    });

    const cached = gGet(KEYS.LAST_DATA, null);
    if (cached && typeof cached === 'object') {
      state.trust = cached.trust || null;
      state.credit = cached.credit || null;
      render();
    }
  }

  function render() {
    const trustEl = document.getElementById('ldm-trust-card');
    const creditEl = document.getElementById('ldm-credit-card');
    const msgEl = document.getElementById('ldm-msg');
    const fab = document.getElementById('ldm-fab');
    if (!trustEl || !creditEl || !msgEl) return;

    trustEl.innerHTML = renderTrustCard(state.trust);
    creditEl.innerHTML = renderCreditCard(state.credit);
    const toggleTrustBtn = document.getElementById('ldm-toggle-trust');
    if (toggleTrustBtn) {
      toggleTrustBtn.onclick = () => {
        uiState.sections.trust = !uiState.sections.trust;
        gSet(KEYS.SECTION_STATE, uiState.sections);
        render();
      };
    }
    const toggleCreditBtn = document.getElementById('ldm-toggle-credit');
    if (toggleCreditBtn) {
      toggleCreditBtn.onclick = () => {
        uiState.sections.credit = !uiState.sections.credit;
        gSet(KEYS.SECTION_STATE, uiState.sections);
        render();
      };
    }

    const refreshTrustBtn = document.getElementById('ldm-refresh-trust');
    if (refreshTrustBtn) {
      refreshTrustBtn.onclick = () => refreshTrust(true);
      refreshTrustBtn.disabled = state.loading;
      if (state.loading) refreshTrustBtn.classList.add('ldm-spin');
      else refreshTrustBtn.classList.remove('ldm-spin');
    }

    const refreshCreditBtn = document.getElementById('ldm-refresh-credit');
    if (refreshCreditBtn) {
      refreshCreditBtn.onclick = () => refreshCredit(true);
      refreshCreditBtn.disabled = state.loading;
      if (state.loading) refreshCreditBtn.classList.add('ldm-spin');
      else refreshCreditBtn.classList.remove('ldm-spin');
    }

    if (state.error) {
      msgEl.textContent = state.error;
      msgEl.style.display = 'block';
    } else {
      msgEl.style.display = 'none';
    }

    if (fab) {
      const estimatedGain = state.credit?.estimatedGain;
      if (estimatedGain === null || estimatedGain === undefined || Number.isNaN(Number(estimatedGain))) {
        fab.textContent = '+0';
      } else {
        const n = Number(estimatedGain);
        const v = Math.round(n);
        fab.textContent = `${v >= 0 ? '+' : ''}${v}`;
      }
    }

    if (typeof uiState.scheduleDockLayout === 'function') {
      uiState.scheduleDockLayout();
    }
  }

  async function refreshAll(manual = false, opts = {}) {
    const formatCreditError = (err) => {
      const msg = String(err?.message || '');
      if (err?.status === 401 || /HTTP\s*401/.test(msg)) {
        return '用户未登录 Credit，请打开 Credit 页面并登录';
      }
      return msg || '失败';
    };

    if (state.loading) return;
    const now = Date.now();
    const throttleState = readThrottleState();
    const minInterval = manual ? THROTTLE.MANUAL_MIN_INTERVAL_MS : THROTTLE.MIN_INTERVAL_MS;
    if (state.lastRequestAt > 0 && now - state.lastRequestAt < minInterval) return;
    const lockToken = tryAcquireCrossTabLock();
    if (!lockToken) return;
    const onlyCredit = !!opts.onlyCredit;
    const onlyTrust = !!opts.onlyTrust;
    const shouldFetchTrust = onlyCredit ? false : (manual || throttleState.trust.nextAllowedAt <= now);
    const isCreditPaused = !manual && throttleState.credit.pausedUntil > now;
    const shouldFetchCredit = onlyTrust ? false : (manual || (!isCreditPaused && throttleState.credit.nextAllowedAt <= now));
    if (!shouldFetchTrust && !shouldFetchCredit) {
      releaseCrossTabLock(lockToken);
      return;
    }

    state.lastRequestAt = now;
    state.loading = true;
    state.error = '';
    render();

    try {
      const trustPromise = shouldFetchTrust
        ? fetchTrustData()
        : Promise.resolve(state.trust);
      const creditPromise = shouldFetchCredit
        ? fetchCreditData()
        : Promise.resolve(state.credit);

      const [trustRes, creditRes] = await Promise.allSettled([
        trustPromise,
        creditPromise,
      ]);
      const errs = [];
      if (shouldFetchTrust) {
        if (trustRes.status === 'fulfilled') {
          state.trust = trustRes.value;
          updateSourceSuccess('trust');
        } else {
          errs.push(`等级: ${trustRes.reason?.message || '失败'}`);
          updateSourceFailure('trust');
        }
      }

      if (shouldFetchCredit) {
        if (creditRes.status === 'fulfilled') {
          state.credit = creditRes.value;
          updateSourceSuccess('credit');
        } else {
          const creditErr = creditRes.reason;
          errs.push(`LDC: ${formatCreditError(creditErr)}`);
          updateSourceFailure('credit');
          const msg = String(creditErr?.message || '');
          if (creditErr?.status === 401 || /HTTP\s*401/.test(msg)) {
            mergeThrottleState({
              credit: { pausedUntil: Date.now() + THROTTLE.CREDIT_401_PAUSE_MS },
            });
          }
        }
      }

      if (errs.length) {
        state.error = manual ? `部分刷新失败：${errs.join('；')}` : `部分数据更新失败：${errs.join('；')}`;
      } else if (isCreditPaused) {
        state.error = `LDC 自动请求已暂停至 ${formatClockTime(throttleState.credit.pausedUntil)}，可点击刷新重试`;
      }
      gSet(KEYS.LAST_DATA, { trust: state.trust, credit: state.credit, ts: Date.now() });
    } catch (err) {
      state.error = manual
        ? `刷新失败：${err?.message || '未知错误'}`
        : (err?.message || '数据获取失败');
      if (shouldFetchTrust) updateSourceFailure('trust');
      if (shouldFetchCredit) updateSourceFailure('credit');
    } finally {
      state.loading = false;
      releaseCrossTabLock(lockToken);
      render();
    }
  }

  function refreshCredit(manual = true) {
    return refreshAll(manual, { onlyCredit: true });
  }

  function refreshTrust(manual = true) {
    return refreshAll(manual, { onlyTrust: true });
  }

  function activateHome() {
    ensureUI();
    render();
    if (!refreshTimer) {
      refreshAll(false);
      refreshTimer = setInterval(() => {
        if (isLinuxdoPage()) refreshAll(false);
      }, THROTTLE.BASE_INTERVAL_MS);
    }
  }

  function deactivateHome() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    const root = document.getElementById('ldm-tw-root');
    if (root) root.remove();
  }

  function onRouteMaybeChanged() {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    if (isLinuxdoPage()) activateHome();
    else deactivateHome();
  }

  function startRouteWatcher() {
    if (routeWatcherStarted) return;
    routeWatcherStarted = true;

    const rawPushState = history.pushState;
    history.pushState = function (...args) {
      const ret = rawPushState.apply(this, args);
      onRouteMaybeChanged();
      return ret;
    };

    const rawReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const ret = rawReplaceState.apply(this, args);
      onRouteMaybeChanged();
      return ret;
    };

    window.addEventListener('popstate', onRouteMaybeChanged);
    window.addEventListener('hashchange', onRouteMaybeChanged);
  }

  function init() {
    startRouteWatcher();
    if (isLinuxdoPage()) activateHome();
    else deactivateHome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
