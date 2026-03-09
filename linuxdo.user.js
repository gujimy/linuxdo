// ==UserScript==
// @name         Linux.do 
// @namespace    https://linux.do/
// @version      1.0.0
// @description  等级 + LDC
// @author       code01
// @match        https://linux.do/*
// @match        https://credit.linux.do/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      connect.linux.do
// @connect      credit.linux.do
// @connect      linux.do
// @downloadURL  https://raw.githubusercontent.com/gujimy/linuxdo/main/linuxdo.user.js
// @updateURL    https://raw.githubusercontent.com/gujimy/linuxdo/main/linuxdo.meta.js
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

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
  };

  const uiState = {
    dragging: false,
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
      const r = await fetch(url, { credentials: 'include', headers });
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
      return '<div class="ldm-empty">暂无积分数据</div>';
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
            <div class="ldm-stat">
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
      #ldm-tw-root, #ldm-tw-root * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
      #ldm-tw-root .ldm-hide { display: none; }
      #ldm-tw-root .ldm-show { display: block; }
      #ldm-tw-root .ldm-muted { color: #64748b; }
      #ldm-tw-root .ldm-ok { color: #059669; font-weight: 700; }
      #ldm-tw-root .ldm-bad { color: #e11d48; font-weight: 700; }
      #ldm-tw-root .ldm-empty { color: #64748b; font-size: 12px; }
      #ldm-tw-root .ldm-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
      #ldm-tw-root .ldm-scroll::-webkit-scrollbar-thumb { background: rgba(100,116,139,0.45); border-radius: 9999px; }
      #ldm-tw-root .ldm-spin { animation: ldm-spin 0.8s linear infinite; }
      #ldm-tw-root .ldm-panel-head { padding: 12px 14px; background: linear-gradient(90deg, #0f172a, #334155); color: #fff; display:flex; align-items:center; justify-content:space-between; }
      #ldm-tw-root .ldm-head-title { font-size: 14px; font-weight: 700; line-height: 1.2; }
      #ldm-tw-root .ldm-head-sub { font-size: 11px; color: #cbd5e1; }
      #ldm-tw-root .ldm-refresh-btn { width: 32px; height: 32px; border: 0; border-radius: 10px; background: rgba(255,255,255,.2); color: #fff; cursor: pointer; }
      #ldm-tw-root .ldm-panel-body { padding: 12px; overflow-y: auto; flex:1; min-height:0; display:flex; flex-direction:column; gap:10px; }
      #ldm-tw-root .ldm-card { border: 1px solid #e2e8f0; border-radius: 16px; background: #fff; padding: 12px; }
      #ldm-tw-root .ldm-block { display:flex; flex-direction:column; gap: 10px; }
      #ldm-tw-root .ldm-block-head { display:flex; align-items:center; justify-content:space-between; }
      #ldm-tw-root .ldm-block-title { font-size: 12px; color:#64748b; }
      #ldm-tw-root .ldm-head-actions { display:flex; align-items:center; gap:8px; }
      #ldm-tw-root .ldm-pill { font-size: 12px; border-radius: 999px; padding: 2px 8px; text-decoration:none; }
      #ldm-tw-root .ldm-pill-ok { background:#dcfce7; color:#047857; }
      #ldm-tw-root .ldm-pill-bad { background:#ffe4e6; color:#be123c; }
      #ldm-tw-root .ldm-pill-link { background:#cffafe; color:#0e7490; }
      #ldm-tw-root .ldm-toggle-btn { width: 32px; height:32px; border-radius:999px; border:1px solid #cbd5e1; background:#fff; color:#475569; cursor:pointer; font-size:16px; font-weight:700; line-height:1; }
      #ldm-tw-root .ldm-level-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
      #ldm-tw-root .ldm-level { font-size: 24px; line-height: 1.1; font-weight: 900; color:#0f172a; }
      #ldm-tw-root .ldm-item { margin-bottom: 6px; }
      #ldm-tw-root .ldm-item-top { display:flex; align-items:center; justify-content:space-between; font-size:12px; margin-bottom:2px; }
      #ldm-tw-root .ldm-item-name { color:#334155; }
      #ldm-tw-root .ldm-item-val { font-weight:700; }
      #ldm-tw-root .ldm-progress { height: 6px; border-radius:999px; background:#e2e8f0; overflow:hidden; }
      #ldm-tw-root .ldm-progress-fill { height:100%; }
      #ldm-tw-root .ldm-progress-ok { background:#10b981; }
      #ldm-tw-root .ldm-progress-bad { background:#f43f5e; }
      #ldm-tw-root .ldm-stats-grid { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:8px; margin-bottom:10px; }
      #ldm-tw-root .ldm-stat { background:#f8fafc; border-radius:12px; padding:8px; }
      #ldm-tw-root .ldm-stat-label { font-size:11px; color:#64748b; }
      #ldm-tw-root .ldm-stat-value { font-size:13px; line-height:1.15; font-weight:800; color:#0f172a; margin-top:2px; white-space:nowrap; }
      #ldm-tw-root .ldm-summary-box { background: linear-gradient(90deg, #ecfeff, #f0fdfa); border-radius: 12px; padding: 8px; font-size: 12px; margin-bottom:8px; }
      #ldm-tw-root .ldm-row { display:flex; align-items:center; justify-content:space-between; font-size:12px; }
      #ldm-tw-root .ldm-row + .ldm-row { margin-top:4px; }
      #ldm-tw-root .ldm-row-key { color:#334155; font-weight:700; }
      #ldm-tw-root .ldm-list { display:flex; flex-direction:column; gap:4px; }
      #ldm-tw-root #ldm-panel {
        resize: both;
        min-width: 240px;
        min-height: 220px;
        max-width: 92vw;
        max-height: 88vh;
      }
      @keyframes ldm-spin { to { transform: rotate(360deg); } }
    `);

    const root = document.createElement('div');
    root.id = 'ldm-tw-root';
    root.innerHTML = `
      <div id="ldm-fab-wrap" style="position:fixed;z-index:99999;">
        <button id="ldm-fab" style="width:48px;height:48px;border-radius:999px;box-shadow:0 12px 24px rgba(2,6,23,.2);background:#fff;color:#059669;font-size:12px;font-weight:800;border:1px solid #bbf7d0;cursor:pointer;">
          +0
        </button>
      </div>

      <div id="ldm-panel" style="position:fixed;z-index:99998;width:270px;height:88vh;max-width:70vw;border-radius:16px;border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.9);backdrop-filter:blur(10px);box-shadow:0 22px 45px rgba(15,23,42,.25);overflow:hidden;display:none;flex-direction:column;">
        <div class="ldm-panel-head">
          <div>
            <div class="ldm-head-title">Linux.do</div>
            <div class="ldm-head-sub">等级 + LDC</div>
          </div>
          <button id="ldm-refresh" class="ldm-refresh-btn">↻</button>
        </div>

        <div class="ldm-panel-body ldm-scroll">
          <section class="ldm-card" id="ldm-trust-card"></section>
          <section class="ldm-card" id="ldm-credit-card"></section>
          <div id="ldm-msg" class="ldm-empty" style="display:none;color:#e11d48;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const panel = root.querySelector('#ldm-panel');
    const fabWrap = root.querySelector('#ldm-fab-wrap');
    const fab = root.querySelector('#ldm-fab');
    const refresh = root.querySelector('#ldm-refresh');

    const defaultHeight = Math.round((window.innerHeight || 900) * 0.88);
    const savedSize = gGet(KEYS.PANEL_SIZE, { width: 270, height: defaultHeight });
    if (savedSize && typeof savedSize === 'object') {
      const w = Math.max(240, Math.min(window.innerWidth * 0.92, Number(savedSize.width) || 270));
      const h = Math.max(220, Math.min(window.innerHeight * 0.88, Number(savedSize.height) || defaultHeight));
      panel.style.width = `${Math.round(w)}px`;
      panel.style.height = `${Math.round(h)}px`;
    }

    const savedPos = gGet(KEYS.FAB_POS, { left: 0, bottom: 72 });
    const applyPosition = (leftPx, bottomPx) => {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 900;
      const panelHeight = Math.round(panel.getBoundingClientRect().height || Number(savedSize?.height) || defaultHeight);
      const left = Math.max(0, Math.min(vw - 56, Number(leftPx) || 0));
      const bottom = Math.max(8, Number(bottomPx) || 72);
      const maxPanelBottom = Math.max(8, vh - panelHeight - 8);
      const panelBottom = Math.min(bottom + 56 + 12, maxPanelBottom);
      fabWrap.style.left = `${left}px`;
      fabWrap.style.bottom = `${bottom}px`;
      panel.style.left = `${left}px`;
      panel.style.bottom = `${panelBottom}px`;
    };
    // 兼容旧版存储（right/bottom）并迁移到 left/bottom
    if (savedPos && typeof savedPos === 'object' && savedPos.left === undefined && savedPos.right !== undefined) {
      const migratedLeft = Math.max(0, (window.innerWidth || 1280) - Number(savedPos.right || 20) - 48);
      applyPosition(migratedLeft, savedPos.bottom);
    } else {
      applyPosition(savedPos.left, savedPos.bottom);
    }

    const isOpen = !!gGet(KEYS.PANEL_OPEN, false);
    if (isOpen) panel.style.display = 'flex';
    const sectionState = gGet(KEYS.SECTION_STATE, { trust: true, credit: true });
    uiState.sections = {
      trust: sectionState?.trust !== false,
      credit: sectionState?.credit !== false,
    };

    // 拖动悬浮按钮（位置记忆，支持鼠标/触屏）
    fab.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      uiState.dragging = false;
      const startX = e.clientX;
      const startY = e.clientY;
      const currentLeft = parseFloat(fabWrap.style.left) || 0;
      const currentBottom = parseFloat(fabWrap.style.bottom) || 20;

      const onMove = (ev) => {
        uiState.dragging = true;
        const nextLeft = currentLeft + (ev.clientX - startX);
        const nextBottom = currentBottom + (startY - ev.clientY);
        applyPosition(nextLeft, nextBottom);
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        gSet(KEYS.FAB_POS, {
          left: parseFloat(fabWrap.style.left) || 0,
          bottom: parseFloat(fabWrap.style.bottom) || 20,
        });
        setTimeout(() => { uiState.dragging = false; }, 50);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    fab.addEventListener('click', () => {
      if (uiState.dragging) return;
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      gSet(KEYS.PANEL_OPEN, panel.style.display !== 'none');
    });

    refresh.addEventListener('click', () => refreshAll(true));
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        const rect = panel.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        gSet(KEYS.PANEL_SIZE, {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        // 缩放后重新约束位置，避免顶部出界
        const left = parseFloat(fabWrap.style.left) || 0;
        const bottom = parseFloat(fabWrap.style.bottom) || 20;
        applyPosition(left, bottom);
      });
      ro.observe(panel);
    }

    window.addEventListener('resize', () => {
      const left = parseFloat(fabWrap.style.left) || 0;
      const bottom = parseFloat(fabWrap.style.bottom) || 20;
      applyPosition(left, bottom);
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
    const refreshBtn = document.getElementById('ldm-refresh');
    const fab = document.getElementById('ldm-fab');
    if (!trustEl || !creditEl || !msgEl || !refreshBtn) return;

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

    if (state.loading) {
      refreshBtn.classList.add('ldm-spin');
    } else {
      refreshBtn.classList.remove('ldm-spin');
    }

    if (state.error) {
      msgEl.textContent = state.error;
      msgEl.style.display = 'block';
    } else {
      msgEl.style.display = 'none';
    }

    if (fab) {
      const todayGain = state.credit?.todayGain;
      if (todayGain === null || todayGain === undefined || Number.isNaN(Number(todayGain))) {
        fab.textContent = '+0';
      } else {
        const n = Number(todayGain);
        const v = Math.round(n);
        fab.textContent = `${v >= 0 ? '+' : ''}${v}`;
      }
    }
  }

  async function refreshAll(manual = false) {
    if (state.loading) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      const [trustRes, creditRes] = await Promise.allSettled([
        fetchTrustData(),
        fetchCreditData(),
      ]);
      const errs = [];
      if (trustRes.status === 'fulfilled') state.trust = trustRes.value;
      else errs.push(`等级: ${trustRes.reason?.message || '失败'}`);
      if (creditRes.status === 'fulfilled') state.credit = creditRes.value;
      else errs.push(`LDC: ${creditRes.reason?.message || '失败'}`);

      if (errs.length) {
        state.error = manual ? `部分刷新失败：${errs.join('；')}` : `部分数据更新失败：${errs.join('；')}`;
      }
      gSet(KEYS.LAST_DATA, { trust: state.trust, credit: state.credit, ts: Date.now() });
    } catch (err) {
      state.error = manual
        ? `刷新失败：${err?.message || '未知错误'}`
        : (err?.message || '数据获取失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  function init() {
    ensureUI();
    render();
    refreshAll(false);
    setInterval(() => refreshAll(false), 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
