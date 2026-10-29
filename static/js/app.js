/* 
   SOLARVISION  app.js  (Part 1 of 3)
   Core State  Session  Intel Bar  Sidebar  History Bar 
   Utility helpers  API layer  Log engine  Notification toasts
 */

'use strict';

/* 
   1. GLOBAL STATE
 */
const SS = {
  /* session */
  session: {
    inspections: [],      // array of result objects
    defects:     0,
    panels:      0,
    model:       'yolov26',
    simMode:     true,
    lastScan:    null,
    totalEnergyGenerated: 847,
    totalEnergyLost:      0,
    criticalCount:        0,
    farmHealth:           null,
    weatherLabel:         '17C Sydney',
  },
  /* UI state */
  ui: {
    sidebarCollapsed: false,
    activePage:       'dashboard',
    currentInspection: null,    // last full result object
    selectedPanelId:   null,    // farm modal
    historyChipActive: null,
  },
  /* conf */
  conf: {
    pricePerKwh: 0.34,
    cleanCost:   85,
  },
};

/* 
   2. UTILITY HELPERS
 */
const Utils = (() => {

  function fmt(n, dec=1) {
    if (n === null || n === undefined || isNaN(n)) return '';
    return Number(n).toFixed(dec);
  }

  function fmtAUD(n) {
    if (n === null || n === undefined || isNaN(n)) return '$';
    return '$' + Number(n).toFixed(2);
  }

  function fmtWh(n) {
    if (n === null || n === undefined) return ' Wh';
    return Number(n).toFixed(1) + ' Wh';
  }

  function fmtPct(n) {
    if (n === null || n === undefined) return '%';
    return Number(n).toFixed(1) + '%';
  }

  function ts() {
    const d = new Date();
    return d.toTimeString().slice(0,8);
  }

  function dateStr(d) {
    d = d || new Date();
    return d.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' });
  }

  function healthLabel(score) {
    if (score === null || score === undefined) return '';
    if (score >= 90) return 'Excellent';
    if (score >= 75) return 'Good';
    if (score >= 55) return 'Moderate';
    if (score >= 35) return 'Poor';
    return 'Critical';
  }

  function healthColor(score) {
    if (score >= 90) return '#22c55e';
    if (score >= 75) return '#4ade80';
    if (score >= 55) return '#eab308';
    if (score >= 35) return '#f97316';
    return '#ef4444';
  }

  function priorityFromConf(conf, cls) {
    const crit = ['physical_damage','hotspot','burn_mark','delamination'];
    const high = ['soiling','bird_dropping','shadow','discoloration'];
    if (crit.includes(cls)) return conf > 0.6 ? 'Critical' : 'High';
    if (high.includes(cls)) return conf > 0.7 ? 'High' : 'Medium';
    return conf > 0.8 ? 'Medium' : 'Low';
  }

  function energyLossFromHealth(health) {
    const panelWh = 400;
    const loss = Math.max(0, (100 - health) / 100 * panelWh * 0.35);
    return parseFloat(loss.toFixed(2));
  }

  function soilingFromHealth(health) {
    return parseFloat(Math.max(0, (100 - health) * 0.6).toFixed(1));
  }

  function cleanDate(health) {
    const daysMap = [
      [90, 180], [75, 90], [55, 30], [35, 14], [0, 3]
    ];
    let days = 90;
    for (const [thresh, d] of daysMap) {
      if (health >= thresh) { days = d; break; }
    }
    const d = new Date();
    d.setDate(d.getDate() + days);
    return { date: dateStr(d), days };
  }

  function annualLoss(whPerInspection) {
    return parseFloat((whPerInspection / 1000 * SS.conf.pricePerKwh * 365).toFixed(2));
  }

  function paybackDays(whPerInspection) {
    const roi = roiFromEnergyLoss(whPerInspection);
    if (roi.dailyAud <= 0) return '';
    return Math.ceil(SS.conf.cleanCost / roi.dailyAud) + ' days';
  }

  function roiFromEnergyLoss(whPerInspection, cyclesPerDay=3.44) {
    const wh = Number(whPerInspection) || 0;
    const cycles = Math.max(1, Number(cyclesPerDay) || 3.44);
    const price = Number(SS.conf.pricePerKwh) || 0;
    const dailyKwh = wh * cycles / 1000;
    const dailyAud = dailyKwh * price;
    const hourlyAud = dailyAud / 24;
    const annualAud = dailyAud * 365;
    const paybackDays = dailyAud > 0 ? Math.ceil((Number(SS.conf.cleanCost) || 0) / dailyAud) : null;
    return { cycles, dailyKwh, dailyAud, hourlyAud, annualAud, paybackDays };
  }

  function el(id) { return document.getElementById(id); }

  function setText(id, val) {
    const e = el(id);
    if (e) e.textContent = val;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function debounce(fn, ms=200) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(()=>fn(...args), ms); };
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random()*16|0;
      return (c==='x' ? r : (r&0x3|0x8)).toString(16);
    });
  }

  function clamp(v, mn, mx) { return Math.min(mx, Math.max(mn, v)); }

  return { fmt, fmtAUD, fmtWh, fmtPct, ts, dateStr, healthLabel, healthColor,
           priorityFromConf, energyLossFromHealth, soilingFromHealth,
           cleanDate, annualLoss, paybackDays, roiFromEnergyLoss, el, setText, escHtml,
           debounce, uuid, clamp };
})();

/* 
   3. LOG ENGINE
 */
const Log = (() => {
  function _append(terminalId, tag, tagClass, msg) {
    const term = Utils.el(terminalId);
    if (!term) return;
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML =
      `<span class="log-time">${Utils.ts()}</span>` +
      `<span class="log-tag ${tagClass}">[${tag}]</span>` +
      `<span class="log-msg"> ${Utils.escHtml(msg)}</span>`;
    term.appendChild(line);
    term.scrollTop = term.scrollHeight;
  }
  const sys   = (id, m) => _append(id, 'SYSTEM', 'sys',  m);
  const info  = (id, m) => _append(id, 'INFO',   'info', m);
  const ok    = (id, m) => _append(id, 'OK',     'ok',   m);
  const warn  = (id, m) => _append(id, 'WARN',   'warn', m);
  const error = (id, m) => _append(id, 'ERROR',  'error',m);
  const clear = (id)    => { const e = Utils.el(id); if (e) e.innerHTML = ''; };
  return { sys, info, ok, warn, error, clear };
})();

/* 
   4. TOAST NOTIFICATIONS
 */
const Toast = (() => {
  let container;
  function _ensureContainer() {
    if (container) return;
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText =
      'position:fixed;top:48px;right:16px;z-index:9999;display:flex;' +
      'flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }
  function show(msg, type='info', duration=3500) {
    _ensureContainer();
    const colours = {
      info:    { bg:'#3b82f6', icon:'' },
      success: { bg:'#22c55e', icon:'' },
      warn:    { bg:'#f59e0b', icon:'' },
      error:   { bg:'#ef4444', icon:'' },
    };
    const c = colours[type] || colours.info;
    const t = document.createElement('div');
    t.style.cssText =
      `background:${c.bg};color:#fff;padding:8px 14px;border-radius:8px;` +
      `font-size:.78rem;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.2);` +
      `display:flex;align-items:center;gap:8px;pointer-events:all;` +
      `animation:slideInRight .2s ease;max-width:320px;`;
    t.innerHTML = `<span>${c.icon}</span><span>${Utils.escHtml(msg)}</span>`;
    container.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity .3s ease';
      setTimeout(() => t.remove(), 320);
    }, duration);
  }
  return { show,
    success: (m,d) => show(m,'success',d),
    warn:    (m,d) => show(m,'warn',d),
    error:   (m,d) => show(m,'error',d),
    info:    (m,d) => show(m,'info',d),
  };
})();

/* 
   5. API LAYER
 */
const API = (() => {
  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body),
      headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }
  async function get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }
  const inspect     = (fd)   => post('/api/inspect', fd);
  const inspectVideo= (fd)   => post('/api/inspect_video', fd);
  const getResults  = ()     => get('/api/results');
  const getSchedule = ()     => get('/api/schedule');
  const getWorkorders=()     => get('/api/workorders');
  const getReport   = (id)   => get(`/api/report/${id}`);
  const markWODone  = (id)   => post(`/api/workorders/${id}/complete`, {});
  const resetAll    = ()     => post('/api/reset', {});
  const exportCSV   = ()     => { window.location = '/api/export/csv'; };
  return { post, get, inspect, inspectVideo, getResults, getSchedule,
           getWorkorders, getReport, markWODone, resetAll, exportCSV };
})();

/* 
   6. SESSION MANAGER
 */
const Session = (() => {
  const KEY = 'solarvision_session_v5';

  function normalizeResult(result) {
    if (!result) return result;
    const dets = result.detections || [];
    if (result.stage1_image) result.original_image = result.stage1_image;
    if (result.stage2_image) result.annotated_image = result.stage2_image;
    if (result.health_score == null && result.health != null) result.health_score = Number(result.health);
    if (result.health == null && result.health_score != null) result.health = Number(result.health_score);
    if (!result.health_label && result.health_score != null) result.health_label = Utils.healthLabel(result.health_score);
    if (result.energy_loss == null && result.energy_lost != null) result.energy_loss = Number(result.energy_lost);
    if (result.energy_lost == null && result.energy_loss != null) result.energy_lost = Number(result.energy_loss);
    if (result.total_defects == null) result.total_defects = dets.length;

    if (result.soiling_pct == null) {
      if (result.soiling != null) {
        result.soiling_pct = Number(result.soiling) || 0;
      } else {
        const soilingDets = dets.filter(d => ['soiling', 'bird_dropping'].includes(d.class));
        result.soiling_pct = soilingDets.length
          ? Math.min(100, Math.max(...soilingDets.map(d => (Number(d.confidence) || 0) * 100)))
          : 0;
      }
    }
    if (result.soiling == null) result.soiling = result.soiling_pct;
    return result;
  }

  function nextPanelId() {
    const used = new Set(
      (SS.session.inspections || [])
        .map(r => String(r.panel_id || '').toUpperCase())
        .filter(id => /^P\d+$/.test(id))
    );
    for (let i = 1; i <= 40; i += 1) {
      const id = 'P' + String(i).padStart(2, '0');
      if (!used.has(id)) return id;
    }
    let n = 41;
    while (used.has('P' + String(n).padStart(2, '0'))) n += 1;
    return 'P' + String(n).padStart(2, '0');
  }

  function assignFarmPanelId(result) {
    const current = String(result.panel_id || '').trim();
    if (/^P\d+$/i.test(current)) {
      result.panel_id = current.toUpperCase().replace(/^P(\d+)$/i, (_, n) => 'P' + String(parseInt(n, 10)).padStart(2, '0'));
      return result.panel_id;
    }
    if (current && !result.source_panel_id) result.source_panel_id = current;
    result.panel_id = nextPanelId();
    return result.panel_id;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        session: SS.session,
        conf:    SS.conf,
      }));
    } catch(e) {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.session) Object.assign(SS.session, d.session);
      if (d.conf)    Object.assign(SS.conf,    d.conf);
      SS.session.inspections = (SS.session.inspections || []).map(normalizeResult);
      normalizePanelIds();
      const latest = SS.session.inspections[0];
      if (latest && typeof latest.sim_mode === 'boolean') SS.session.simMode = latest.sim_mode;
    } catch(e) {}
  }

  function normalizePanelIds() {
    const used = new Set(
      SS.session.inspections
        .map(r => String(r.panel_id || ''))
        .filter(id => /^P\d+$/i.test(id))
    );
    let next = used.size
      ? Math.max(...Array.from(used).map(id => parseInt(id.replace(/\D/g, ''), 10))) + 1
      : 1;
    SS.session.inspections.forEach(r => {
      if (/^P\d+$/i.test(String(r.panel_id || ''))) return;
      let id = 'P' + String(next).padStart(2, '0');
      while (used.has(id)) {
        next += 1;
        id = 'P' + String(next).padStart(2, '0');
      }
      r.panel_id = id;
      used.add(id);
      next += 1;
    });
    save();
  }

  function reset() {
    SS.session.inspections      = [];
    SS.session.defects          = 0;
    SS.session.panels           = 0;
    SS.session.lastScan         = null;
    SS.session.totalEnergyLost  = 0;
    SS.session.criticalCount    = 0;
    SS.session.farmHealth       = null;
    SS.ui.currentInspection     = null;
    save();
  }

  function addInspection(result) {
    result = normalizeResult(result);
    assignFarmPanelId(result);
    if (typeof result.sim_mode === 'boolean') SS.session.simMode = result.sim_mode;
    SS.session.inspections.unshift(result);
    SS.session.defects      += (result.detections || []).length;
    SS.session.panels       += 1;
    SS.session.lastScan      = Utils.ts();
    SS.session.totalEnergyLost += (result.energy_loss || 0);
    if ((result.health_score || 100) < 35) SS.session.criticalCount += 1;
    // recalc avg farm health
    const scores = SS.session.inspections.map(i => i.health_score || 100);
    SS.session.farmHealth = scores.reduce((a,b)=>a+b,0) / scores.length;
    SS.ui.currentInspection = result;
    save();
  }

  function getAll()    { return SS.session.inspections; }
  function getLatest() { return SS.session.inspections[0] || null; }

  return { save, load, reset, addInspection, getAll, getLatest, normalizeResult, nextPanelId, assignFarmPanelId };
})();

/* 
   7. INTEL BAR
 */
const IntelBar = (() => {
  function update() {
    const s = SS.session;
    Utils.setText('ib-weather',   s.weatherLabel || '');
    Utils.setText('ib-generated', s.totalEnergyGenerated + ' Wh');
    Utils.setText('ib-lost',      Utils.fmtWh(s.totalEnergyLost));
    Utils.setText('ib-critical',  s.criticalCount);
    Utils.setText('ib-health',    s.farmHealth ? Utils.fmt(s.farmHealth,0) + '/100' : '');
    Utils.setText('ib-scans',     s.inspections.length);
    Utils.setText('ib-last',      s.lastScan || '');
    // sim pill
    const pill = Utils.el('simPill');
    if (pill) pill.style.display = s.simMode ? '' : 'none';
    ['dashSimBadge', 'inspSimBadge', 'videoSimBadge'].forEach(id => {
      const el = Utils.el(id);
      if (el) el.style.display = s.simMode ? '' : 'none';
    });
  }

  function startWeatherPoll() {
    // Static for now  extend with real weather API if needed
    const labels = ['17C Sydney','18C Sydney','16C Sydney','19C Partly Cloudy'];
    let i = 0;
    setInterval(() => {
      SS.session.weatherLabel = labels[i++ % labels.length];
      Utils.setText('ib-weather', SS.session.weatherLabel);
    }, 60000);
  }

  return { update, startWeatherPoll };
})();

/* 
   8. SIDEBAR
 */
const Sidebar = (() => {
  function init() {
    const toggle = Utils.el('sidebarToggle');
    if (toggle) toggle.addEventListener('click', toggleCollapse);
    updateSessionStats();
  }

  function toggleCollapse() {
    SS.ui.sidebarCollapsed = !SS.ui.sidebarCollapsed;
    const shell = document.querySelector('.shell');
    if (shell) shell.classList.toggle('collapsed', SS.ui.sidebarCollapsed);
  }

  function setActive(page) {
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.page === page);
    });
    SS.ui.activePage = page;
  }

  function updateSessionStats() {
    const s = SS.session;
    Utils.setText('ss-inspections', s.inspections.length);
    Utils.setText('ss-defects',     s.defects);
    Utils.setText('ss-panels',      s.panels);
    const pill = Utils.el('ss-model');
    if (pill) pill.textContent = s.model.toUpperCase();
    // Results badge
    const badge = Utils.el('resultsBadge');
    if (badge) {
      const n = s.inspections.length;
      badge.textContent = n;
      badge.style.display = n > 0 ? '' : 'none';
    }
  }

  return { init, toggleCollapse, setActive, updateSessionStats };
})();

/* 
   9. HISTORY BAR
 */
const HistoryBar = (() => {
  function render() {
    const chips = Utils.el('historyChips');
    if (!chips) return;
    const inspections = Session.getAll();
    if (!inspections.length) {
      chips.innerHTML = '<span class="history-empty">No inspections yet</span>';
      return;
    }
    chips.innerHTML = inspections.slice(0, 30).map((insp, i) => {
      const label = Utils.healthLabel(insp.health_score);
      const score = insp.health_score != null ? Math.round(insp.health_score) : '';
      const cls   = label.toLowerCase();
      return `<span class="history-chip ${cls}"
                    onclick="HistoryBar.selectChip(${i})"
                    title="${insp.panel_id}  ${label} (${score}/100) @ ${insp.timestamp || ''}">${insp.panel_id || 'P?'} ${score}</span>`;
    }).join('');
  }

  function selectChip(idx) {
    const insp = Session.getAll()[idx];
    if (!insp) return;
    SS.ui.currentInspection = insp;
    // If on dashboard, refresh the result view
    if (typeof Dashboard !== 'undefined') Dashboard.showResult(insp);
    Toast.info(`Loaded ${insp.panel_id}  ${Utils.healthLabel(insp.health_score)}`);
  }

  return { render, selectChip };
})();

/*
   10. NON-REPORT PAGE PRINTING
 */
const AppPrint = (() => {
  let targetPage = null;
  let originalTitle = null;

  function prepare() {
    targetPage = document.querySelector('.page.active');
    if (!targetPage || targetPage.id === 'page-report') return false;

    originalTitle = document.title;
    const heading = targetPage.querySelector('.page-title');
    if (heading?.textContent.trim()) {
      document.title = `SolarVision - ${heading.textContent.trim()}`;
    }

    document.documentElement.classList.add('non-report-printing');
    document.body.classList.add('non-report-printing');
    targetPage.classList.add('print-target');
    return true;
  }

  function cleanup() {
    document.documentElement.classList.remove('non-report-printing');
    document.body.classList.remove('non-report-printing');
    targetPage?.classList.remove('print-target');
    targetPage = null;
    if (originalTitle !== null) document.title = originalTitle;
    originalTitle = null;
  }

  function printPage() {
    if (!prepare()) return;
    try {
      void targetPage.offsetHeight;
      window.print();
    } finally {
      cleanup();
    }
  }

  window.addEventListener('afterprint', cleanup);
  return { printPage };
})();

/* 
   11. PAGE ROUTER
 */
const Router = (() => {
  // On index.html pages are toggled by section id
  function goTo(pageId) {
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === 'page-' + pageId);
    });
    Sidebar.setActive(pageId);
    SS.ui.activePage = pageId;
    window.scrollTo(0,0);
    // Re-render target page with latest session data
    const all = (typeof Session !== 'undefined') ? Session.getAll() : [];
    setTimeout(() => {
      if (pageId === 'dashboard'  && typeof Dashboard      !== 'undefined') {
        const latest = Session.getLatest ? Session.getLatest() : all[all.length-1];
        if (latest) Dashboard.showResult(latest);
      }
      if (pageId === 'results'    && typeof ResultsPage    !== 'undefined') ResultsPage.render();
      if (pageId === 'farm'       && typeof FarmOverview   !== 'undefined') FarmOverview.init();
      if (pageId === 'schedule'   && typeof SchedulePage   !== 'undefined') SchedulePage.init();
      if (pageId === 'workorders' && typeof WorkOrdersPage !== 'undefined') WorkOrdersPage.init();
      if (pageId === 'report'     && typeof ReportPage     !== 'undefined') ReportPage.init();
      if (pageId === 'analytics'  && typeof AnalyticsPage  !== 'undefined') {
        AnalyticsPage.init();
        if (typeof AnalyticsCharts !== 'undefined' && all.length) AnalyticsCharts.renderAll(all);
      }
    }, 80);
  }

  // For nav anchors within same page
  function initNavLinks() {
    document.querySelectorAll('.nav-item[data-page]').forEach(link => {
      link.addEventListener('click', e => {
        const page = link.dataset.page;
        if (!page) return;
        // Same-page navigation (index.html)
        const pageEl = Utils.el('page-' + page);
        if (pageEl) {
          e.preventDefault();
          goTo(page);
        }
        // Cross-page links handled by href naturally
      });
    });
  }

  return { goTo, initNavLinks };
})();

/* 
   11. SIM DATA GENERATOR
 */
const SimData = (() => {
  const CLASSES = [
    'soiling','physical_damage','bird_dropping','hotspot',
    'shadow','burn_mark','delamination','discoloration','crack',
  ];

  function randomDetections(count, conf) {
    const n = Math.floor(Math.random() * Math.min(count + 2, 6));
    return Array.from({length: n}, (_, i) => {
      const cls  = CLASSES[Math.floor(Math.random() * CLASSES.length)];
      const c    = parseFloat((conf + (Math.random() * (0.95 - conf))).toFixed(3));
      return {
        class:       cls,
        confidence:  c,
        priority:    Utils.priorityFromConf(c, cls),
        bbox:        [
          Math.round(Math.random()*400),
          Math.round(Math.random()*300),
          Math.round(50 + Math.random()*200),
          Math.round(50 + Math.random()*150),
        ],
      };
    });
  }

  function buildResult(panelId, model, conf, location) {
    const detections = randomDetections(3, conf);
    const critCount  = detections.filter(d => d.priority === 'Critical').length;
    const health     = parseFloat(Utils.clamp(
      100 - detections.length * 8 - critCount * 5 + (Math.random() * 10 - 5), 5, 100
    ).toFixed(1));
    const energyLoss = Utils.energyLossFromHealth(health);
    const soiling    = Utils.soilingFromHealth(health);
    const { date: cleanDateStr, days: cleanDays } = Utils.cleanDate(health);

    return {
      id:            Utils.uuid(),
      panel_id:      panelId,
      model:         model,
      confidence_thresh: conf,
      location:      location || '',
      timestamp:     Utils.ts(),
      date:          Utils.dateStr(),
      health_score:  health,
      health_label:  Utils.healthLabel(health),
      energy_loss:   energyLoss,
      soiling_pct:   soiling,
      detections:    detections,
      total_defects: detections.length,
      clean_date:    cleanDateStr,
      clean_days:    cleanDays,
      priority:      critCount > 0 ? 'Critical' : (detections.length > 2 ? 'High' : 'Medium'),
      nlp_report:    _generateNLP(panelId, health, detections, energyLoss, cleanDateStr),
      annotated_image: null,  // filled by real API
      stage1: {
        model:       model,
        detections:  detections.length,
        conf_avg:    detections.length
          ? parseFloat((detections.reduce((a,d)=>a+d.confidence,0)/detections.length).toFixed(3))
          : 0,
      },
    };
  }

  function _generateNLP(panelId, health, detections, energyLoss, cleanDate) {
    const label   = Utils.healthLabel(health);
    const defStr  = detections.length
      ? detections.map(d => d.class.replace(/_/g,' ')).join(', ')
      : 'no defects';
    const urgency = health < 35 ? 'URGENT: Immediate maintenance required.'
                  : health < 55 ? 'Schedule maintenance within 2 weeks.'
                  : health < 75 ? 'Monitor and plan routine cleaning.'
                  : 'Panel in good condition. Routine monitoring recommended.';
    return (
      `Panel ${panelId} inspection completed.

` +
      `Health Score: ${health}/100 (${label})
` +
      `Detected issues: ${defStr}.
` +
      `Estimated energy loss: ${energyLoss} Wh per cycle.
` +
      `Recommended cleaning date: ${cleanDate}.

` +
      urgency
    );
  }

  function farmPanel(id) {
    const health = parseFloat(Utils.clamp(40 + Math.random() * 60, 10, 100).toFixed(1));
    return {
      id,
      panel_id:     'P' + String(id).padStart(2,'0'),
      health_score: health,
      health_label: Utils.healthLabel(health),
      soiling_pct:  Utils.soilingFromHealth(health),
      energy_loss:  Utils.energyLossFromHealth(health),
      defects:      Math.floor(Math.random() * 4),
    };
  }

  function generateFarm(n=40) {
    return Array.from({length: n}, (_, i) => farmPanel(i + 1));
  }

  return { buildResult, generateFarm, randomDetections };
})();

/* 
   12. GLOBAL RESET
 */
function showConfirmModal() {
  const m = Utils.el('confirmModal');
  if (m) m.style.display = 'flex';
}
function hideConfirmModal() {
  const m = Utils.el('confirmModal');
  if (m) m.style.display = 'none';
}

async function globalConfirmReset() {
  hideConfirmModal();
  try {
    await API.resetAll();
  } catch(e) {}
  Session.reset();
  IntelBar.update();
  Sidebar.updateSessionStats();
  HistoryBar.render();
  Toast.success('Session reset successfully');
  setTimeout(() => window.location.reload(), 500);
}

/* 
   13. INIT
 */
document.addEventListener('DOMContentLoaded', () => {
  // Load persisted session
  Session.load();

  // Boot UI
  IntelBar.update();
  IntelBar.startWeatherPoll();
  Sidebar.init();
  Sidebar.updateSessionStats();
  HistoryBar.render();
  Router.initNavLinks();

  // Page-specific inits (each page module calls its own init)
  const page = document.body.dataset.page;
  if (page === 'dashboard' || document.getElementById('page-dashboard')) {
    if (typeof Dashboard !== 'undefined') Dashboard.init();
  }
  if (document.getElementById('page-inspection')) {
    if (typeof PanelApp !== 'undefined') PanelApp.init();
  }
  if (document.getElementById('page-analytics')) {
    if (typeof AnalyticsPage !== 'undefined') AnalyticsPage.init();
  }
  if (document.getElementById('page-schedule')) {
    if (typeof SchedulePage !== 'undefined') SchedulePage.init();
  }
  if (document.getElementById('page-workorders')) {
    if (typeof WorkOrdersPage !== 'undefined') WorkOrdersPage.init();
  }
  if (document.getElementById('page-report')) {
    if (typeof ReportPage !== 'undefined') ReportPage.init();
  }

  console.log('%c SolarVision AI ready', 'color:#f59e0b;font-weight:bold;font-size:14px');
});

/* 
   SOLARVISION  app.js  (Part 2 of 3)
   PanelApp  Dashboard  AnalyticsPage
 */

/* 
   14. PANEL APP (New Inspection + Video + Tello stub)
 */
const PanelApp = (() => {
  let _panelCounter = 1;
  let _selectedFile = null;
  let _selectedVideo = null;
  let _selectedImageDataUrl = null;
  let _selectedVideoFrameDataUrl = null;
  let _lastVideoFrameResults = [];
  let _currentConf = 0.25;
  let _currentModel = 'yolov26';

  /*  Init  */
  function init() {
    _bindModelSelector('#modelSelector', v => { _currentModel = v; SS.session.model = v; Sidebar.updateSessionStats(); });
    _bindModelSelector('#videoModelSelector', () => {});
    _bindModelSelector('#telloModelSelector', () => {});
    onVideoFrameModeChange();
    _updatePanelIdInput();
    _renderHistoryList();
    Log.sys('inspLog', 'Ready. Upload an image to begin.');
    Log.sys('videoLog', 'Upload a video to begin analysis.');
    Log.sys('telloLog', 'Ready  connect drone to begin.');
  }

  /*  Model selector binding  */
  function _bindModelSelector(selector, onChange) {
    const container = document.querySelector(selector);
    if (!container) return;
    container.querySelectorAll('input[type=radio]').forEach(radio => {
      radio.addEventListener('change', () => {
        container.querySelectorAll('.model-option, .model-mini').forEach(el => el.classList.remove('selected'));
        const parent = radio.closest('.model-option') || radio.closest('.model-mini');
        if (parent) parent.classList.add('selected');
        onChange(radio.value);
      });
    });
  }

  /*  Drag & Drop  */
  function onDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('dragover');
  }
  function onDragLeave(e) {
    e.currentTarget.classList.remove('dragover');
  }
  function onDropImage(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) _handleImageFile(file);
  }
  function onDropVideo(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) _handleVideoFile(file);
  }
  function onImageSelect(e) { if (e.target.files[0]) _handleImageFile(e.target.files[0]); }
  function onVideoSelect(e) { if (e.target.files[0]) _handleVideoFile(e.target.files[0]); }

  function _handleImageFile(file) {
    _selectedFile = file;
    _fileToDataUrl(file).then(url => { _selectedImageDataUrl = url; }).catch(() => {});
    const preview = Utils.el('imagePreview');
    const inner   = Utils.el('imageDropInner');
    if (preview && inner) {
      const url = URL.createObjectURL(file);
      preview.src = url;
      preview.style.display = 'block';
      inner.style.display = 'none';
    }
    Log.info('inspLog', `File selected: ${file.name} (${(file.size/1024).toFixed(1)} KB)`);
  }

  function _handleVideoFile(file) {
    _selectedVideo = file;
    _selectedVideoFrameDataUrl = null;
    const preview = Utils.el('videoPreview');
    const inner   = Utils.el('videoDropInner');
    if (preview && inner) {
      preview.src = URL.createObjectURL(file);
      preview.style.display = 'block';
      inner.style.display = 'none';
      preview.onloadeddata = () => {
        _captureVideoFrame(preview).then(url => { _selectedVideoFrameDataUrl = url; }).catch(() => {});
      };
    }
    Log.info('videoLog', `Video selected: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)`);
  }

  function _fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function _captureVideoFrame(video) {
    return new Promise((resolve, reject) => {
      const capture = () => {
        try {
          const canvas = document.createElement('canvas');
          const srcW = video.videoWidth || 960;
          const srcH = video.videoHeight || 540;
          const scale = Math.min(1, 960 / Math.max(1, srcW));
          canvas.width = Math.max(1, Math.round(srcW * scale));
          canvas.height = Math.max(1, Math.round(srcH * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.76));
        } catch (e) {
          reject(e);
        }
      };
      if (video.readyState >= 2) capture();
      else video.addEventListener('loadeddata', capture, { once: true });
    });
  }

  async function _captureVideoFrameAt(video, frameIndex, totalFrames) {
    if (!video) return null;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const originalTime = video.currentTime || 0;
    const targetTime = duration
      ? Math.min(Math.max((duration * (frameIndex + 0.5)) / Math.max(1, totalFrames), 0), Math.max(0, duration - 0.08))
      : originalTime;

    try {
      if (duration) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            video.removeEventListener('seeked', finish);
            resolve();
          };
          video.addEventListener('seeked', finish, { once: true });
          video.currentTime = targetTime;
          setTimeout(finish, 900);
        });
      }
      return await _captureVideoFrame(video);
    } catch (_) {
      return _selectedVideoFrameDataUrl;
    } finally {
      if (duration) {
        try { video.currentTime = originalTime; } catch (_) {}
      }
    }
  }

  async function _attachVideoFrameImages(frames) {
    const video = Utils.el('videoPreview');
    if (!video || !frames.length) return frames;
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].image && !frames[i].original_image && !frames[i].frame_image) {
        frames[i].image = await _captureVideoFrameAt(video, i, frames.length);
      }
    }
    return frames;
  }

  function _nextAvailablePanelId(usedIds) {
    const used = usedIds || new Set();
    const nums = Session.getAll()
      .map(r => String(r.panel_id || '').match(/^P(\d+)$/i))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10));
    let next = nums.length ? Math.max(...nums) + 1 : 1;
    let id = 'P' + String(next).padStart(2, '0');
    while (used.has(id)) {
      next += 1;
      id = 'P' + String(next).padStart(2, '0');
    }
    used.add(id);
    return id;
  }

  function _syncPanelCounterFromSession() {
    const nums = Session.getAll()
      .map(r => String(r.panel_id || '').match(/^P(\d+)$/i))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10));
    _panelCounter = nums.length ? Math.max(...nums) + 1 : _panelCounter;
    _updatePanelIdInput();
  }

  function _summariseClasses(detections) {
    const counts = {};
    (detections || []).forEach(d => {
      const name = String(d.class || 'defect').replace(/_/g, ' ');
      counts[name] = (counts[name] || 0) + 1;
    });
    const entries = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    if (!entries.length) return 'no visible defects';
    return entries.slice(0, 3).map(([name, count]) => `${name} (${count})`).join(', ');
  }

  function _videoFrameNarrative(result, videoResult) {
    const dets = result.detections || [];
    const frameText = result.frame_total ? `frame ${result.frame_index}/${result.frame_total}` : 'selected frame';
    const action = result.health_score < 55
      ? 'Prioritise cleaning and a close visual check before the next production cycle.'
      : result.health_score < 75
        ? 'Schedule cleaning and continue monitoring this panel in the next pass.'
        : 'Continue routine monitoring; no urgent repair is indicated for this frame.';
    const totalFrames = videoResult.frames_analysed || videoResult.total_frames || result.frame_total || 1;
    const totalDefects = videoResult.total_defects ?? dets.length;
    const totalEnergy = videoResult.energy_lost ?? videoResult.total_energy ?? result.energy_loss;
    return (
      `Drone video analysis mapped ${frameText} to panel ${result.panel_id}. ` +
      `This frame scored ${result.health_score}/100 (${result.health_label}) with ${dets.length} detected issue${dets.length === 1 ? '' : 's'}: ${_summariseClasses(dets)}. ` +
      `Across the full video, ${totalFrames} frame${totalFrames === 1 ? '' : 's'} were analysed with ${totalDefects} total defects and an estimated combined loss of ${Utils.fmtWh(totalEnergy)} per cycle. ` +
      `${action}`
    );
  }

  function _makeVideoFrameResult(videoResult, frame, idx, sessionId, model, conf, location, panelId) {
    const health = Number(frame.health ?? videoResult.avg_health ?? 85);
    const detections = (frame.detections || []).map(d => Object.assign({}, d, {
      frame: frame.frame || idx + 1,
      source: 'Drone video',
    }));
    const image = frame.original_image || frame.annotated_image || frame.frame_image || frame.image || _selectedVideoFrameDataUrl;
    const energyPerFrame = videoResult.energy_lost != null
      ? Number(videoResult.energy_lost || 0) / Math.max(1, videoResult.frames_analysed || videoResult.total_frames || (videoResult.frames || []).length)
      : Utils.energyLossFromHealth(health);
    const result = SimData.buildResult(panelId, model, conf, location || 'Drone video');
    result.panel_id = panelId;
    result.source = 'Drone video';
    result.video_id = sessionId;
    result.frame_index = idx + 1;
    result.frame_total = videoResult.frames_analysed || videoResult.total_frames || (videoResult.frames || []).length;
    result.video_total_defects = videoResult.total_defects ?? detections.length;
    result.video_total_energy_loss = videoResult.energy_lost ?? videoResult.total_energy ?? result.energy_loss;
    result.video_avg_health = videoResult.avg_health ?? health;
    result.stage1 = frame.stage1 || result.stage1;
    result.sim_mode = !!videoResult.sim_mode;
    result.health_score = parseFloat(health.toFixed(1));
    result.health_label = Utils.healthLabel(health);
    result.energy_loss = parseFloat(energyPerFrame.toFixed(1));
    result.soiling_pct = Number(frame.soiling ?? frame.soiling_pct ?? 0);
    result.soiling = result.soiling_pct;
    result.detections = detections;
    result.total_defects = detections.length;
    result.original_image = image || result.original_image;
    result.annotated_image = image || result.annotated_image;
    result.nlp_report = _videoFrameNarrative(result, videoResult);
    return result;
  }

  /*  Confidence  */
  function onConfChange(val) {
    _currentConf = parseFloat(val);
    Utils.setText('confVal', _currentConf.toFixed(2));
  }

  /*  Panel ID  */
  function _updatePanelIdInput() {
    const inp = Utils.el('panelIdInput');
    if (inp) inp.value = 'P' + String(_panelCounter).padStart(2,'0');
  }

  /*  Pipeline stepper  */
  function _setPipelineStep(step, state) {
    // state: 'active' | 'complete' | 'error' | ''
    const el = document.querySelector(`.pipe-step[data-step="${step}"]`);
    if (!el) return;
    el.classList.remove('active','complete','error');
    if (state) el.classList.add(state);
  }
  function _resetPipeline() {
    for (let i=1;i<=6;i++) _setPipelineStep(i,'');
    const badge = Utils.el('pipelineStatus');
    if (badge) { badge.textContent='READY'; badge.className='pipeline-status-badge'; }
  }
  function _setPipelineRunning() {
    _resetPipeline();
    const badge = Utils.el('pipelineStatus');
    if (badge) { badge.textContent='RUNNING'; badge.className='pipeline-status-badge running'; }
  }
  function _setPipelineDone(ok=true) {
    const badge = Utils.el('pipelineStatus');
    if (ok) {
      badge.textContent='DONE'; badge.className='pipeline-status-badge done';
    } else {
      badge.textContent='ERROR'; badge.className='pipeline-status-badge error';
    }
  }

  /*Run Inspection  */
  async function runInspection() {
    const panelId  = (Utils.el('panelIdInput')?.value || 'P01').trim();
    const location = Utils.el('locationInput')?.value || '';
    const btn      = Utils.el('btnRunInspection');

    if (!_selectedFile && !SS.session.simMode) {
      Toast.warn('Upload an image first'); return;
    }
    if (btn) { btn.disabled=true; btn.textContent='\u23F3 Running...'; }
    _setPipelineRunning();
    Log.clear('inspLog');
    Log.sys('inspLog', `Starting inspection for panel ${panelId}`);

    let result;
    try {
      if (_selectedFile) {
        // Real API call
        _setPipelineStep(1,'active');
        Log.info('inspLog','Uploading image');
        const fd = new FormData();
        fd.append('file', _selectedFile);
        fd.append('panel_id', panelId);
        fd.append('model', _currentModel);
        fd.append('conf', _currentConf);
        fd.append('sim_mode', 'false');
        fd.append('location', location);
        _setPipelineStep(1,'complete'); _setPipelineStep(2,'active');
        Log.info('inspLog','Running Stage 1 detection');
        result = await API.inspect(fd);
        SS.session.simMode = !!result.sim_mode;
        _setPipelineStep(2,'complete'); _setPipelineStep(3,'active');
        await _sleep(200);
        _setPipelineStep(3,'complete'); _setPipelineStep(4,'active');
        Log.info('inspLog','Generating NLP report');
        await _sleep(200);
        _setPipelineStep(4,'complete'); _setPipelineStep(5,'active');
        Log.info('inspLog','Computing ROI');
        await _sleep(100);
        _setPipelineStep(5,'complete'); _setPipelineStep(6,'active');
        Log.ok('inspLog','Inspection complete!');
        _setPipelineStep(6,'complete');
      } else {
        // Sim mode
        await _simulatePipeline('inspLog');
        result = SimData.buildResult(panelId, _currentModel, _currentConf, location);
        SS.session.simMode = true;
      }
      if (_selectedImageDataUrl) {
        result.source_image = _selectedImageDataUrl;
        result.original_image = result.original_image || _selectedImageDataUrl;
        result.annotated_image = result.annotated_image || _selectedImageDataUrl;
      }

      // Store and update UI
      Session.addInspection(result);
      IntelBar.update();
      Sidebar.updateSessionStats();
      HistoryBar.render();
      _renderLastResult(result);
      _renderHistoryList();
      _incrementPanelId();
      _setPipelineDone(true);

      Log.ok('inspLog', `Health: ${result.health_score}/100 (${result.health_label})`);
      Log.ok('inspLog', `Defects: ${result.total_defects} detected`);
      Toast.success(`Panel ${panelId}  ${result.health_label} (${result.health_score}/100)`);

      // Broadcast result to ALL pages
      broadcastResult(result);

    } catch(err) {
      _setPipelineDone(false);
      Log.error('inspLog', err.message || 'Inspection failed');
      Toast.error('Inspection failed: ' + (err.message || 'Unknown error'));
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='\u{1F50D} Run Inspection'; }
    }
  }

  async function _simulatePipeline(logId) {
    const steps = [
      [1,'Uploading image'],
      [2,'Running Stage 1 detection (YOLOv8)'],
      [3,'Running Stage 2 classification'],
      [4,'Generating NLP report'],
      [5,'Computing ROI & clean schedule'],
      [6,'Finalising results'],
    ];
    for (const [step, msg] of steps) {
      _setPipelineStep(step,'active');
      Log.info(logId, msg);
      await _sleep(280 + Math.random()*200);
      _setPipelineStep(step,'complete');
    }
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _incrementPanelId() {
    _panelCounter++;
    _updatePanelIdInput();
  }

  /*  Last Result card  */
  function _renderLastResult(r) {
    const body = Utils.el('lastResultBody');
    if (!body) return; const rows = [
      ['Panel ID',   r.panel_id],
      ['Health',     `${r.health_score}/100  ${r.health_label}`],
      ['Defects',    r.total_defects],
      ['Energy Lost',Utils.fmtWh(r.energy_loss)],
      ['Model',      r.model?.toUpperCase()],
      ['Clean Date', r.clean_date],
    ];
    body.innerHTML = rows.map(([label,val]) =>`<div class="last-result-row"><span class="lrr-label">${label}</span><span class="lrr-val">${Utils.escHtml(String(val))}</span></div>`
    ).join('');
  }

  /*  History List  */
  function _renderHistoryList() {
    const list = Utils.el('inspHistoryList');
    if (!list) return;
    const all = Session.getAll();
    if (!all.length) {
      list.innerHTML = '<span class="empty-state-mini">No inspections yet</span>';
      return;
    }
    list.innerHTML = all.slice(0,15).map((r,i) => {
      const col = r.health_score >= 75 ? 'var(--green-dark)'
                : r.health_score >= 55 ? '#92400e'
                : 'var(--red)';
      return `<div class="insp-hist-item" onclick="PanelApp.loadHistItem(${i})"><span style="font-weight:700">${r.panel_id}</span><span style="color:${col};font-weight:700">${r.health_score}/100</span><span style="color:var(--dark-4);font-size:.65rem">${r.timestamp||''}</span></div>`;
    }).join('');
  }

  function loadHistItem(idx) {
    const r = Session.getAll()[idx];
    if (!r) return;
    SS.ui.currentInspection = r;
    _renderLastResult(r);
    Toast.info(`Loaded ${r.panel_id}`);
  }

  /*  Video Analysis  */
  function onVideoFrameModeChange() {
    const mode = Utils.el('videoFrameMode')?.value || 'auto';
    const maxFrames = Utils.el('maxFrames');
    if (maxFrames) maxFrames.disabled = mode === 'auto';
  }

  async function analyzeVideo() {
    const btn = Utils.el('btnAnalyzeVideo');
    const frameMode = Utils.el('videoFrameMode')?.value || 'auto';
    const maxF = parseInt(Utils.el('maxFrames')?.value || 6);
    const conf = parseFloat(Utils.el('videoConfSlider')?.value || 0.25);
    const model = document.querySelector('input[name="vmodel"]:checked')?.value || 'yolov26';

    if (!_selectedVideo && !SS.session.simMode) {
      Toast.warn('Upload a video first'); return;
    }
    if (btn) { btn.disabled=true; btn.textContent='\u{1F3AC} Analyzing...'; }
    Log.clear('videoLog');
    Log.sys('videoLog','Starting video analysis');

    try {
      let result;
      if (_selectedVideo) {
        const fd = new FormData();
        fd.append('file', _selectedVideo);
        fd.append('frame_mode', frameMode);
        fd.append('max_frames', maxF);
        fd.append('conf', conf);
        fd.append('model', model);
        fd.append('sim_mode', 'false');
        Log.info('videoLog', frameMode === 'auto' ? 'Uploading video - automatic panel selection' : `Uploading video - manual limit ${maxF}`);
        result = await API.inspectVideo(fd);
        SS.session.simMode = !!result.sim_mode;
      } else {
        await _sleep(800);
        result = _buildVideoSimResult(maxF, conf, model);
        SS.session.simMode = true;
      }
      result.frames = await _attachVideoFrameImages(result.frames || []);
      if (!_selectedVideoFrameDataUrl && Utils.el('videoPreview')) {
        try {
          _selectedVideoFrameDataUrl = await _captureVideoFrame(Utils.el('videoPreview'));
        } catch (_) {}
      }
      const sessionId = 'V' + String(Date.now()).slice(-4);
      const usedPanelIds = new Set(Session.getAll().map(r => r.panel_id));
      _lastVideoFrameResults = (result.frames || []).map((frame, idx) => {
        frame.panel_id = _nextAvailablePanelId(usedPanelIds);
        return _makeVideoFrameResult(result, frame, idx, sessionId, model, conf, 'Drone video', frame.panel_id);
      });
      _renderVideoSummary(result);
      _renderFrameStrip(result.frames || []);
      _lastVideoFrameResults.slice().reverse().forEach(frameResult => Session.addInspection(frameResult));
      _syncPanelCounterFromSession();
      const firstFrameResult = _lastVideoFrameResults[0] || SimData.buildResult(sessionId, model, conf, 'Drone video');
      broadcastResult(firstFrameResult);
      Log.ok('videoLog', `Analysis complete  ${result.frames_analysed} frames, ${result.total_defects} defects`);
      Toast.success(`Video analysis complete  ${result.total_defects} defects found`);
    } catch(err) {
      Log.error('videoLog', err.message || 'Video analysis failed');
      Toast.error('Video analysis failed');
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='\u{1F3AC} Analyze Video'; }
    }
  }

  function _buildVideoSimResult(maxF, conf, model) {
    const frames = Array.from({length: maxF}, (_, i) => {
      const dets = SimData.randomDetections(2, conf);
      const h = Utils.clamp(60 + Math.random()*38, 20, 100);
      return { frame: i+1, health: parseFloat(h.toFixed(1)), detections: dets };
    });
    const avgH = frames.reduce((a,f)=>a+f.health,0)/frames.length;
    const totalDef = frames.reduce((a,f)=>a+f.detections.length,0);
    return {
      frames_analysed: maxF, total_defects: totalDef,
      avg_health: parseFloat(avgH.toFixed(1)),
      energy_lost: Utils.energyLossFromHealth(avgH) * maxF,
      model, frames,
    };
  }

  function _renderVideoSummary(r) {
    const framesAnalysed = r.frames_analysed || r.total_frames || (r.frames || []).length;
    const energyLost = r.energy_lost ?? r.total_energy ?? 0;
    Utils.setText('vs-frames',  framesAnalysed || '');
    Utils.setText('vs-panels',  framesAnalysed || '');
    Utils.setText('vs-defects', r.total_defects   || 0);
    Utils.setText('vs-health',  r.avg_health ? r.avg_health.toFixed(1)+'/100' : '');
    Utils.setText('vs-energy',  Utils.fmtWh(energyLost));
    Utils.setText('vs-model',   (r.model||'').toUpperCase());
  }

  function _renderFrameStrip(frames) {
    const strip = Utils.el('framesStrip');
    if (!strip) return;
    if (!frames.length) {
      strip.innerHTML = '<div class="empty-state-mini">No frames</div>'; return;
    }
    strip.innerHTML = frames.map((f,i) => {
      const image = f.original_image || f.annotated_image || f.frame_image || f.image || '';
      const label = f.panel_id || `F${f.frame}`;
      const media = image
        ? `<img src="${Utils.escHtml(image)}" alt="${Utils.escHtml(label)}">`
        : `<div class="frame-thumb-empty">${Utils.escHtml(label)}</div>`;
      return `<div class="frame-thumb ${Utils.healthLabel(f.health).toLowerCase()}"
            title="Show ${Utils.escHtml(label)} frame result"
            onclick="PanelApp.selectFrame(${i})">${media}<div class="frame-thumb-label">${Utils.escHtml(label)}</div><div class="frame-thumb-health">${f.health?.toFixed(0)}%</div></div>`;
    }).join('');
    selectFrame(0, false);
  }

  function selectFrame(idx, announce = true) {
    document.querySelectorAll('.frame-thumb').forEach((el,i)=>el.classList.toggle('active',i===idx));
    const r = _lastVideoFrameResults[idx];
    if (r) {
      SS.ui.currentInspection = r;
      Dashboard.showResult(r);
      _renderLastResult(r);
    }
    if (announce) {
      Log.info('videoLog', `Frame ${idx+1} selected - dashboard updated`);
      Toast.info(`Showing frame ${idx+1} result`);
    }
  }

  /*  Reset  */
  function resetSession() { showConfirmModal(); }
  function confirmReset()  { globalConfirmReset(); }

  return {
    init, onDragOver, onDragLeave, onDropImage, onDropVideo,
    onImageSelect, onVideoSelect, onConfChange,
    runInspection, analyzeVideo, onVideoFrameModeChange, selectFrame,
    loadHistItem, resetSession, confirmReset,
  };
})();

/* 
   15. DASHBOARD
 */
const Dashboard = (() => {
  let _currentResult = null;
  let _currentTab = 'boxes';

  function init() {
    _renderEmpty();
    // Load last result if exists
    const last = Session.getLatest();
    if (last) showResult(last);
  }

  /*  Empty state  */
  function _renderEmpty() {
    const canvas = Utils.el('inspectionCanvas');
    const ph     = Utils.el('canvasPlaceholder');
    if (ph) ph.classList.remove('hidden');
    if (canvas) canvas.style.display='none';
    Utils.setText('gaugeScore','');
    Utils.setText('gaugeLabel','');
    Utils.setText('aiReportText','Run an inspection to generate a report.');
    Utils.setText('recText','No data  run an inspection.');
  }

  /*  Show result  */
  function showResult(r) {
    if (!r) return;
    _currentResult = r;

    // Image viewer
    _renderImageTab(_currentTab);

    // Health gauge
    _updateGauge(r.health_score, r.health_label);

    // Recommendation
    _updateRecommendation(r);

    // Detections mini
    _renderDetectionsMini(r.detections || []);

    // AI report
    const rep = Utils.el('aiReportText');
    if (rep) rep.textContent = r.nlp_report || '';

    // Stage1 stats
    _updateStage1Stats(r);

    // Confidence bar
    _updateConfBar(r);

    // DNA bar
    _updateDNABar(r.detections || []);

    // Detections table (full)
    _renderDetectionsTable(r.detections || []);

    // Charts update
    if (typeof DashCharts !== 'undefined') DashCharts.update(r);
  }

  /*  Image viewer tabs  */
  function switchTab(tab) {
    _currentTab = tab;
    document.querySelectorAll('.img-tab').forEach(t =>t.classList.toggle('active', (t.dataset.tab || t.dataset.mode) === tab)
    );
    _renderImageTab(tab);
  }

  function setViewMode(tab, btn) {
    _currentTab = tab;
    document.querySelectorAll('.img-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    _renderImageTab(tab);
  }

  function _renderImageTab(tab) {
    const canvas = Utils.el('inspectionCanvas');
    const ph     = Utils.el('canvasPlaceholder');
    const r      = _currentResult;
    if (!r) return;

    if ((tab === 'boxes' || tab === 'annotated') && (r.annotated_image || r.original_image)) {
      if (ph) ph.classList.add('hidden');
      if (canvas) { canvas.style.display='block'; _drawAnnotated(canvas, r); }
    } else if (tab === 'heatmap' && (r.original_image || r.annotated_image)) {
      if (ph) ph.classList.add('hidden');
      if (canvas) { canvas.style.display='block'; _drawImageHeatmap(canvas, r); }
    } else if (tab === 'original' && r.original_image) {
      if (ph) ph.classList.add('hidden');
      if (canvas) { canvas.style.display='block'; _drawImage(canvas, r.original_image); }
    } else {
      // sim  show placeholder with health colour overlay
      if (ph) ph.classList.add('hidden');
      if (canvas) { canvas.style.display='block'; _drawSimPanel(canvas, r, tab); }
    }
    const fname = Utils.el('imgFilename');
    if (fname) fname.textContent = r.panel_id + '  ' + (r.timestamp||'');
  }

  function _drawImage(canvas, src) {
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      canvas.width  = img.naturalWidth  || canvas.offsetWidth;
      canvas.height = img.naturalHeight || canvas.offsetHeight;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = src;
  }

  function _drawImageHeatmap(canvas, r) {
    const src = r.original_image || r.stage1_image || r.annotated_image;
    if (!src) {
      _drawSimPanel(canvas, r, 'heatmap');
      return;
    }
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      canvas.width  = img.naturalWidth  || canvas.offsetWidth  || 960;
      canvas.height = img.naturalHeight || canvas.offsetHeight || 540;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(10, 20, 35, .16)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const coordW = r.image_width || r.crop_width || img.naturalWidth || canvas.width || 640;
      const coordH = r.image_height || r.crop_height || img.naturalHeight || canvas.height || 480;
      const sx = canvas.width / coordW;
      const sy = canvas.height / coordH;
      const severity = { Critical: 1, High: .82, Medium: .58, Low: .35 };
      (r.detections || []).forEach(d => {
        const [bx, by, bw, bh] = d.bbox || [260, 190, 120, 90];
        const isXYXY = d.bbox_format === 'xyxy';
        const boxW = isXYXY ? Math.max(1, bw - bx) : bw;
        const boxH = isXYXY ? Math.max(1, bh - by) : bh;
        const x = (bx + boxW / 2) * sx;
        const y = (by + boxH / 2) * sy;
        const radius = Math.max(70, Math.max(boxW * sx, boxH * sy) * 1.6);
        const alpha = severity[d.priority] || .55;
        const heat = ctx.createRadialGradient(x, y, 4, x, y, radius);
        heat.addColorStop(0, `rgba(239, 68, 68, ${alpha})`);
        heat.addColorStop(.35, `rgba(245, 158, 11, ${alpha * .75})`);
        heat.addColorStop(.7, `rgba(234, 179, 8, ${alpha * .28})`);
        heat.addColorStop(1, 'rgba(34, 197, 94, 0)');
        ctx.fillStyle = heat;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      });
    };
    img.src = src;
  }

  function _drawAnnotated(canvas, r) {
    const src = r.original_image || r.stage1_image || r.annotated_image;
    if (!src) {
      _drawSimPanel(canvas, r, 'boxes');
      return;
    }
    const ctx = canvas.getContext('2d');
    const img = new Image();
    const cols = { Critical:'#ef4444', High:'#f97316', Medium:'#eab308', Low:'#22c55e' };
    img.onload = () => {
      canvas.width  = img.naturalWidth  || canvas.offsetWidth  || 960;
      canvas.height = img.naturalHeight || canvas.offsetHeight || 540;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const coordW = r.image_width || r.crop_width || img.naturalWidth || canvas.width || 640;
      const coordH = r.image_height || r.crop_height || img.naturalHeight || canvas.height || 480;
      const sx = canvas.width / coordW;
      const sy = canvas.height / coordH;
      (r.detections || []).forEach(d => {
        const [bx, by, bw, bh] = d.bbox || [0, 0, 0, 0];
        const isXYXY = d.bbox_format === 'xyxy';
        const rawX = isXYXY ? Math.min(bx, bw) : bx;
        const rawY = isXYXY ? Math.min(by, bh) : by;
        const rawW = isXYXY ? Math.abs(bw - bx) : bw;
        const rawH = isXYXY ? Math.abs(bh - by) : bh;
        const x = Utils.clamp(rawX * sx, 0, canvas.width);
        const y = Utils.clamp(rawY * sy, 0, canvas.height);
        const w = Utils.clamp(rawW * sx, 1, canvas.width - x);
        const h = Utils.clamp(rawH * sy, 1, canvas.height - y);
        const col = cols[d.priority] || '#f59e0b';
        const label = `${String(d.class || 'defect').replace(/_/g, ' ')} ${((d.confidence || 0) * 100).toFixed(0)}%`;
        const labelSize = Math.max(12, Math.round(canvas.width / 70));
        const labelH = Math.max(22, Math.round(canvas.width / 44));
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(2, Math.round(canvas.width / 420));
        ctx.strokeRect(x, y, w, h);
        ctx.font = `700 ${labelSize}px Inter, sans-serif`;
        ctx.fillStyle = col;
        ctx.fillRect(x, Math.max(0, y - labelH), ctx.measureText(label).width + 12, labelH);
        ctx.fillStyle = '#111827';
        ctx.fillText(label, x + 6, Math.max(labelSize + 2, y - 6));
      });
    };
    img.src = src;
  }

  function _drawSimPanel(canvas, r, mode) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width = 960;
    const H = canvas.height = 620;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    const cols = 6, rows = 4, gap = 12;
    const padX = 46, padY = 54;
    const cellW = (W - padX * 2 - gap * (cols - 1)) / cols;
    const cellH = (H - padY * 2 - gap * (rows - 1)) / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = padX + col * (cellW + gap);
        const y = padY + row * (cellH + gap);
        const grad = ctx.createLinearGradient(x, y, x + cellW, y + cellH);
        grad.addColorStop(0, mode === 'heatmap' ? '#155e75' : '#173b67');
        grad.addColorStop(1, mode === 'heatmap' ? '#0f766e' : '#0b2447');
        ctx.fillStyle = mode === 'original' ? '#12365f' : grad;
        ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeStyle = 'rgba(255,255,255,.16)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, cellW, cellH);
        ctx.fillStyle = 'rgba(255,255,255,.08)';
        for (let stripe = 1; stripe < 4; stripe++) ctx.fillRect(x + (cellW / 4) * stripe, y + 6, 1, cellH - 12);
      }
    }

    const colors = { Critical:'#ef4444', High:'#f97316', Medium:'#eab308', Low:'#22c55e' };
    (r.detections || []).forEach((d, i) => {
      const raw = d.bbox || [60 + i * 110, 70 + i * 60, 110, 70];
      const x = Math.max(24, Math.min(W - 140, raw[0] * (W / 640)));
      const y = Math.max(24, Math.min(H - 110, raw[1] * (H / 480)));
      const w = Math.max(56, Math.min(180, raw[2] * (W / 640)));
      const h = Math.max(42, Math.min(140, raw[3] * (H / 480)));
      const color = colors[d.priority] || '#f59e0b';
      if (mode === 'heatmap') {
        const radius = Math.max(w, h) * 1.1;
        const heat = ctx.createRadialGradient(x + w/2, y + h/2, 4, x + w/2, y + h/2, radius);
        heat.addColorStop(0, color + 'dd');
        heat.addColorStop(.45, color + '66');
        heat.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = heat;
        ctx.fillRect(x - radius, y - radius, radius * 2 + w, radius * 2 + h);
      } else if (mode !== 'original') {
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.strokeRect(x, y, w, h);
        const label = `${String(d.class || 'defect').replace(/_/g,' ')} ${(d.confidence * 100).toFixed(0)}%`;
        ctx.font = '700 15px Inter, system-ui, sans-serif';
        const labelW = ctx.measureText(label).width + 14;
        ctx.fillStyle = color;
        ctx.fillRect(x, Math.max(0, y - 24), labelW, 22);
        ctx.fillStyle = '#111827';
        ctx.fillText(label, x + 7, Math.max(16, y - 8));
      }
    });

    ctx.fillStyle = 'rgba(255,255,255,.84)';
    ctx.font = '700 18px Inter, system-ui, sans-serif';
    ctx.fillText(`${r.panel_id || 'Panel'} - ${Math.round(r.health_score || 0)}/100`, 30, 32);
  }

  /*  Health Gauge  */
  function _updateGauge(score, label) {
    Utils.setText('gaugeScore', score != null ? Math.round(score) : '');
    const denom = Utils.el('gaugeDenom');
    const lbl   = Utils.el('gaugeLabel');
    if (denom) denom.textContent = score != null ? '/100' : '';
    if (lbl) {
      lbl.textContent  = label || '';
      lbl.className    = 'gauge-label ' + (label||'');
    }
    // Canvas arc
    _drawGaugeArc(score);
  }

  function _drawGaugeArc(score) {
    const canvas = Utils.el('gaugeCanvas');
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const W    = canvas.width  = 120;
    const H    = canvas.height = 70;
    const cx   = W/2, cy = H - 8;
    const r    = 50;
    const pct  = Utils.clamp(score||0, 0, 100) / 100;
    const start= Math.PI;
    const end  = Math.PI + Math.PI * pct;

    ctx.clearRect(0,0,W,H);
    // Track
    ctx.beginPath();
    ctx.arc(cx,cy,r,Math.PI,2*Math.PI);
    ctx.strokeStyle = '#e5e0d8';
    ctx.lineWidth   = 10;
    ctx.stroke();
    // Fill
    ctx.beginPath();
    ctx.arc(cx,cy,r,start,end);
    ctx.strokeStyle = Utils.healthColor(score||0);
    ctx.lineWidth   = 10;
    ctx.lineCap     = 'round';
    ctx.stroke();
  }

  /*  Recommendation  */
  function _updateRecommendation(r) {
    const body = Utils.el('recBody');
    if (!body) return;
    const icons = { Excellent:'', Good:'', Moderate:'', Poor:'', Critical:'' };
    const msgs  = {
      Excellent: 'Panel is in excellent condition. No action needed  schedule routine inspection in 6 months.',
      Good:      'Panel is performing well. Monitor soiling levels and clean within 90 days.',
      Moderate:  'Moderate soiling detected. Schedule cleaning within 30 days to restore output.',
      Poor:      'Significant defects found. Maintenance required within 2 weeks.',
      Critical:  'CRITICAL: Immediate action required. Shutdown panel and schedule urgent repair.',
    };
    const lbl = r.health_label || 'Good';
    body.innerHTML =
      `<span class="rec-icon">${icons[lbl]||''}</span>` +
      `<span class="rec-text">${msgs[lbl]||''}</span>`;
  }

  /*  Detections mini  */
  function _renderDetectionsMini(dets) {
    const list = Utils.el('detectionsMiniList');
    if (!list) return;
    if (!dets.length) {
      list.innerHTML = '<span class="empty-state-mini">No defects detected </span>'; return;
    }
    list.innerHTML = dets.slice(0,5).map(d =>`<div class="detection-mini-item"><span class="det-dot ${d.priority}"></span><span class="det-class">${d.class.replace(/_/g,' ')}</span><span class="det-conf">${(d.confidence*100).toFixed(0)}%</span><span class="priority-pill ${d.priority}">${d.priority}</span></div>`
    ).join('');
  }

  /*  Stage1 Stats  */
  function _updateStage1Stats(r) {
    const s = r.stage1 || {};
    Utils.setText('s1-model',    (s.model||r.model||'').toUpperCase());
    Utils.setText('s1-dets',     s.used_crop ? '1 panel' : (s.enabled === false ? 'SIM' : 'full image'));
    Utils.setText('s1-conf',     s.confidence != null ? (s.confidence*100).toFixed(0)+'%' :
                                  (s.conf_avg != null ? (s.conf_avg*100).toFixed(0)+'%' : ''));
    Utils.setText('s1-health',   r.health_score != null ? Math.round(r.health_score) : '');
    Utils.setText('s1-energy',   Utils.fmtWh(r.energy_loss));
    Utils.setText('s1-soiling',  Utils.fmtPct(r.soiling_pct));
  }

  /*  Confidence bar  */
  function _updateConfBar(r) {
    const wrap = Utils.el('confBarWrap');
    if (!wrap) return;
    const dets = r.detections || [];
    if (!dets.length) { wrap.innerHTML='<span class="empty-state-mini">No detections</span>'; return; }
    wrap.innerHTML = dets.map(d => {
      const w = (d.confidence*100).toFixed(0);
      const col = Utils.healthColor(d.confidence*100);
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:.72rem"><span style="width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dark-3)">${d.class.replace(/_/g,' ')}</span><div style="flex:1;height:6px;background:var(--cream-border);border-radius:99px;overflow:hidden"><div style="width:${w}%;height:100%;background:${col};border-radius:99px;transition:width .4s"></div></div><span style="width:34px;text-align:right;font-weight:700;color:var(--dark)">${w}%</span></div>`;
    }).join('');
  }

  /*  DNA Fingerprint Bar  */
  function _updateDNABar(dets) {
    const wrap = Utils.el('dnaBarWrap');
    if (!wrap) return;
    if (!dets.length) {
      wrap.innerHTML = '<div class="dna-bar-wrap"><div class="dna-segment" style="flex:1;background:var(--green);border-radius:99px"> Clean</div></div>';
      return;
    }
    const cols = { soiling:'#f59e0b', physical_damage:'#ef4444', bird_dropping:'#8b5cf6',
                   hotspot:'#f97316', shadow:'#6b7280', burn_mark:'#dc2626',
                   delamination:'#0ea5e9', discoloration:'#ec4899', crack:'#b45309' };
    wrap.innerHTML =
      `<div class="dna-bar-wrap">` +
      dets.map(d => {
        const col = cols[d.class] || '#999';
        const flex = Math.round(d.confidence * 10);
        return `<div class="dna-segment" style="flex:${flex};background:${col}"
                     data-label="${d.class.replace(/_/g,' ')} ${(d.confidence*100).toFixed(0)}%"></div>`;
      }).join('') +
      `</div>`;
  }

  /*  Detections Table  */
  function _renderDetectionsTable(dets) {
    const tbody = Utils.el('detectionsTableBody');
    if (!tbody) return;
    if (!dets.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No defects detected </td></tr>';
      return;
    }
    tbody.innerHTML = dets.map((d,i) =>`<tr><td>${i+1}</td><td><strong>${d.class.replace(/_/g,' ')}</strong></td><td><div class="conf-bar-cell"><div class="conf-bar-inner" style="width:${(d.confidence*60).toFixed(0)}px;background:${Utils.healthColor(d.confidence*100)}"></div>${(d.confidence*100).toFixed(1)}%</div></td><td><span class="priority-pill ${d.priority}">${d.priority}</span></td><td>${d.bbox ? '['+d.bbox.join(', ')+']' : ''}</td><td>${Utils.dateStr()}</td><td>${_currentResult?.panel_id || ''}</td></tr>`
    ).join('');
    Utils.setText('detectionsCount', dets.length);
  }

  /*  Zoom  */
  function zoomIn()  { _zoom(1.2); }
  function zoomOut() { _zoom(0.85); }
  function _zoom(factor) {
    const canvas = Utils.el('inspectionCanvas');
    if (!canvas) return;
    const w = parseFloat(canvas.style.width || canvas.offsetWidth);
    canvas.style.width  = (w * factor) + 'px';
    canvas.style.height = 'auto';
  }

  function zoom(factor) {
    const canvas = Utils.el('inspectionCanvas');
    if (!canvas) return;
    if (!factor) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      return;
    }
    _zoom(factor);
  }

  return { init, showResult, switchTab, setViewMode, zoomIn, zoomOut, zoom };
})();

/* 
   16. ANALYTICS PAGE
 */
const AnalyticsPage = (() => {

  function init() {
    _updateKPIs();
    _renderCharts();
    setTimeout(_renderCharts, 120);
    _seedROILoss();
    calcROI();
  }

  function refresh() {
    init();
    Toast.info('Analytics refreshed');
  }

  function _updateKPIs() {
    const all = Session.getAll();
    const s   = SS.session;
    Utils.setText('an-scans',    all.length);
    Utils.setText('an-health',   s.farmHealth ? Utils.fmt(s.farmHealth,0) : '');
    Utils.setText('an-defects',  s.defects);
    Utils.setText('an-energy',   Utils.fmt(s.totalEnergyLost,1));
    Utils.setText('an-critical', s.criticalCount);
  }

  function _renderCharts() {
    const all = Session.getAll().slice().reverse();
    if (typeof AnalyticsCharts !== 'undefined') {
      AnalyticsCharts.renderAll(all);
    }
    _showOrHideEmpty('healthTrendChart',  'healthTrendEmpty',  all.length);
    _showOrHideEmpty('defectFreqChart',   'defectFreqEmpty',   all.length);
    _showOrHideEmpty('energyTimelineChart','energyTimelineEmpty',all.length);
    _showOrHideEmpty('dashConfHistChart', 'dashConfHistEmpty', all.length);
    _showOrHideEmpty('dashPriorityChart', 'dashPriorityEmpty', all.length);
    _showOrHideEmpty('panelHealthDistChart','panelHealthDistEmpty',all.length);
  }

  function _showOrHideEmpty(canvasId, emptyId, count) {
    const canvas = Utils.el(canvasId);
    const empty  = Utils.el(emptyId);
    if (canvas) canvas.style.display = count ? 'block' : 'none';
    if (empty)  empty.classList.toggle('visible', !count);
  }

  function _seedROILoss() {
    const input = Utils.el('roiDailyLoss');
    if (!input) return;
    const current = parseFloat(input.value || 0);
    if (current > 0 && input.dataset.auto !== '1') return;
    const latest = Session.getLatest();
    const latestLoss = latest?.video_total_energy_loss || latest?.energy_loss || SS.session.totalEnergyLost || 0;
    input.value = Number(latestLoss).toFixed(1);
    input.dataset.auto = '1';
  }

  function calcROI() {
    const price    = parseFloat(Utils.el('roiPrice')?.value     || SS.conf.pricePerKwh || 0.34);
    const cycleWh  = parseFloat(Utils.el('roiDailyLoss')?.value || SS.session.totalEnergyLost);
    const cleanCost= parseFloat(Utils.el('roiCleanCost')?.value || SS.conf.cleanCost);
    const sydneyPeakSunHours = 4.2;
    const performanceRatio = 0.82;
    const sunlightCycleHours = sydneyPeakSunHours * performanceRatio;

    SS.conf.pricePerKwh = price;
    SS.conf.cleanCost   = cleanCost;

    const dailyKwh  = (cycleWh * sunlightCycleHours) / 1000;
    const dailyAud  = dailyKwh * price;
    const annualLoss= dailyAud * 365;
    const lossPerHr = dailyAud / 24;
    const payback   = dailyAud > 0 ? Math.ceil(cleanCost / dailyAud) + ' days' : '';

    Utils.setText('roi-daily-kwh', dailyKwh.toFixed(3));
    Utils.setText('roi-annual',    '$' + annualLoss.toFixed(2));
    Utils.setText('roi-per-hr',    '$' + lossPerHr.toFixed(4));
    Utils.setText('roi-payback',   payback);
  }

  function resetSession() { showConfirmModal(); }
  function confirmReset()  { globalConfirmReset(); }

  return { init, refresh, calcROI, resetSession, confirmReset };
})();

/* 
   SOLARVISION  app.js  (Part 3 of 3)
   Results  FarmOverview  SchedulePage  WorkOrdersPage  ReportPage
 */

/* 
   17. RESULTS PAGE
 */
const ResultsPage = (() => {
  let _filter = 'all';
  let _search = '';
  let _sortKey = 'timestamp';
  let _sortAsc  = false;

  function init() {
    render();
  }

  function render() {
    let rows = Session.getAll();

    // filter by priority
    if (_filter !== 'all') {
      rows = rows.filter(r => r.priority === _filter ||
        (r.detections||[]).some(d => d.priority === _filter));
    }

    // search
    if (_search.trim()) {
      const q = _search.toLowerCase();
      rows = rows.filter(r =>(r.panel_id||'').toLowerCase().includes(q) ||
        (r.health_label||'').toLowerCase().includes(q) ||
        (r.location||'').toLowerCase().includes(q) ||
        (r.model||'').toLowerCase().includes(q)
      );
    }

    // sort
    rows = _sortRows(rows);

    // update badge
    const badge = Utils.el('resultsBadge2');
    if (badge) { badge.textContent = rows.length; badge.style.display = rows.length ? '' : 'none'; }

    _renderTable(rows);
    _renderClassDist(rows);
    _renderSessionStats();
  }

  function _sortRows(rows) {
    return [...rows].sort((a,b) => {
      let av = a[_sortKey], bv = b[_sortKey];
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return _sortAsc ? -1 :  1;
      if (av > bv) return _sortAsc ?  1 : -1;
      return 0;
    });
  }

  function _renderTable(rows) {
    const tbody = Utils.el('resultsTableBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No results  run inspections to see data</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const healthCol = r.health_score >= 75 ? 'var(--green-dark)'
                      : r.health_score >= 55 ? '#92400e'
                      : r.health_score >= 35 ? 'var(--orange)'
                      : 'var(--red)';
      return `<tr><td><strong>${Utils.escHtml(r.panel_id||'')}</strong></td><td style="font-weight:700;color:${healthCol}">${r.health_score != null ? Math.round(r.health_score) : ''}/100</td><td><span class="gauge-label ${Utils.escHtml(r.health_label||'')}" style="font-size:.62rem;padding:2px 7px">${Utils.escHtml(r.health_label||'')}</span></td><td>${r.total_defects ?? 0}</td><td>${Utils.fmtWh(r.energy_loss)}</td><td><span class="priority-pill ${Utils.escHtml(r.priority||'Low')}">${Utils.escHtml(r.priority||'Low')}</span></td><td>${Utils.escHtml(r.timestamp||'')}</td></tr>`;
    }).join('');
  }

  function _renderClassDist(rows) {
    const counts = {};
    rows.forEach(r => (r.detections||[]).forEach(d => {
      counts[d.class] = (counts[d.class]||0) + 1;
    }));
    const el = Utils.el('classDistBody');
    if (!el) return;
    const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    if (!entries.length) { el.innerHTML = '<span class="empty-state-mini">No defect data</span>'; return; }
    const max = entries[0][1];
    el.innerHTML = entries.map(([cls,n]) =>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:.74rem"><span style="width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dark-3)">${cls.replace(/_/g,' ')}</span><div style="flex:1;height:8px;background:var(--cream-border);border-radius:99px;overflow:hidden"><div style="width:${(n/max*100).toFixed(0)}%;height:100%;background:var(--amber);border-radius:99px;transition:width .4s"></div></div><span style="width:24px;text-align:right;font-weight:700">${n}</span></div>`
    ).join('');
  }

  function _renderSessionStats() {
    const s = SS.session;
    Utils.setText('res-totalScans',   s.inspections.length);
    Utils.setText('res-totalDefects', s.defects);
    Utils.setText('res-avgHealth',    s.farmHealth ? Utils.fmt(s.farmHealth,0)+'/100' : '');
    Utils.setText('res-energyLost',   Utils.fmtWh(s.totalEnergyLost));
    Utils.setText('res-criticals',    s.criticalCount);
  }

  function filter(val, btn) {
    _filter = val;
    document.querySelectorAll('#resultsFilters .chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
    render();
  }

  function search(val) {
    _search = val;
    render();
  }

  function sort(key) {
    if (_sortKey === key) _sortAsc = !_sortAsc;
    else { _sortKey = key; _sortAsc = false; }
    render();
  }

  function resetSession() { showConfirmModal(); }
  function confirmReset()  { globalConfirmReset(); }

  return { init, render, filter, search, sort, resetSession, confirmReset };
})();

/* 
   18. FARM OVERVIEW
 */
const FarmOverview = (() => {
  let _panels  = [];
  let _heatMode = false;

  function init() {
    _buildPanels();
    render();
  }

  function _buildPanels() {
    const inspected = Session.getAll();
    // Start with sim farm, overlay real inspections
    _panels = SimData.generateFarm(40);
    inspected.forEach(insp => {
      const idx = _panels.findIndex(p => p.panel_id === insp.panel_id);
      if (idx >= 0) {
        _panels[idx].health_score = insp.health_score;
        _panels[idx].health_label = insp.health_label;
        _panels[idx].energy_loss  = insp.energy_loss;
        _panels[idx].soiling_pct  = insp.soiling_pct;
        _panels[idx].defects      = insp.total_defects;
        _panels[idx].inspected    = true;
      }
    });
  }

  function render() {
    const grid = document.querySelector('#page-farm .farm-grid');
    if (!grid) return;

    grid.className = 'farm-grid' + (_heatMode ? ' heat-mode' : '');

    grid.innerHTML = _panels.map(p => {
      const cls   = (p.health_label||'uninspected').toLowerCase();
      const heatStyle = _heatMode && p.health_score != null ? ` style="--farm-heat:${Utils.healthColor(p.health_score)}"` : '';
      const score = p.health_score != null ? Math.round(p.health_score) : '';
      return `<div class="farm-panel ${cls}"
                   ${heatStyle}
                   data-id="${p.panel_id}"
                   onclick="FarmOverview.openModal('${p.panel_id}')"
                   title="${p.panel_id}  ${p.health_label||'Uninspected'} (${score})"><span class="panel-label">${p.panel_id}</span><span class="panel-score">${score}</span></div>`;
    }).join('');

    _updateCriticalAlert();
    _updateFarmStats();
    _updateHealthDistChart();
  }

  function _updateCriticalAlert() {
    const crit  = _panels.filter(p => (p.health_score||100) < 35);
    const alert = Utils.el('farmCritAlert');
    if (alert) {
      if (crit.length) {
        alert.style.display = '';
        alert.textContent = ` ${crit.length} CRITICAL panel${crit.length>1?'s':''} detected  immediate attention required!`;
      } else {
        alert.style.display = 'none';
      }
    }
  }

  function _updateFarmStats() {
    const scores = _panels.map(p=>p.health_score||100);
    const avg    = scores.reduce((a,b)=>a+b,0)/scores.length;
    const crit   = _panels.filter(p=>(p.health_score||100)<35).length;
    const poor   = _panels.filter(p=>(p.health_score||100)<55).length;
    Utils.setText('farm-avgHealth', Utils.fmt(avg,0)+'/100');
    Utils.setText('farm-critical',  crit);
    Utils.setText('farm-poor',      poor);
    const inspected = _panels.filter(p => p.inspected).length;
    Utils.setText('farm-panels',    inspected + '/' + _panels.length);
    Utils.setText('farm-energy',    Utils.fmtWh(_panels.reduce((a,p)=>a+(p.energy_loss||0),0)));
  }

  function _updateHealthDistChart() {
    if (typeof FarmCharts !== 'undefined') FarmCharts.updateHealthDist(_panels);
  }

  function toggleView(mode, btn) {
    _heatMode = (mode === 'heat');
    document.querySelectorAll('#page-farm .view-toggle-btn').forEach(b =>b.classList.toggle('active', b.dataset.view === mode)
    );
    document.querySelectorAll('#page-farm .page-actions .btn-outline').forEach(b =>b.classList.toggle('active-toggle', b === btn)
    );
    render();
  }

  function openModal(panelId) {
    const p = _panels.find(x => x.panel_id === panelId);
    if (!p) return;
    SS.ui.selectedPanelId = panelId;

    Utils.setText('modalPanelId',    p.panel_id);
    Utils.setText('modalHealth',     p.health_score != null ? Math.round(p.health_score)+'/100' : '');
    Utils.setText('modalHealthLabel',p.health_label || '');
    Utils.setText('modalSoiling',    Utils.fmtPct(p.soiling_pct));
    Utils.setText('modalEnergy',     Utils.fmtWh(p.energy_loss));
    Utils.setText('modalDefects',    p.defects ?? '');
    Utils.setText('modalCleanDate',  Utils.cleanDate(p.health_score||100).date);

    const modal = Utils.el('panelModal');
    if (modal) modal.style.display = 'flex';
  }

  function closeModal() {
    const modal = Utils.el('panelModal');
    if (modal) modal.style.display = 'none';
  }

  function resetSession() { showConfirmModal(); }
  function confirmReset()  { globalConfirmReset(); }

  return { init, render, toggleView, openModal, closeModal, resetSession, confirmReset };
})();

/* 
   19. SCHEDULE PAGE
 */
const SchedulePage = (() => {
  let _rows   = [];
  let _filter = 'all';
  let _search = '';
  let _sortKey = 'days_until';
  let _sortAsc  = true;

  function init() {
    _buildSchedule();
    render();
  }

  function _buildSchedule() {
    _rows = Session.getAll().map(r => {
      const { date, days } = Utils.cleanDate(r.health_score || 100);
      return {
        panel_id:    r.panel_id,
        health:      r.health_score,
        soiling:     r.soiling_pct,
        energy_loss: r.energy_loss,
        priority:    days <= 7  ? 'High'
                   : days <= 30 ? 'Medium'
                   : 'Low',
        clean_date:  date,
        days_until:  days,
      };
    });
    // Update KPIs
    Utils.setText('sch-week', _rows.filter(r=>r.days_until<=7).length);
    Utils.setText('sch-high', _rows.filter(r=>r.priority==='High').length);
    Utils.setText('sch-med',  _rows.filter(r=>r.priority==='Medium').length);
    Utils.setText('sch-low',  _rows.filter(r=>r.priority==='Low').length);
    Utils.setText('sch-total',_rows.length);
  }

  function render() {
    let rows = [..._rows];
    if (_filter !== 'all') rows = rows.filter(r => r.priority === _filter);
    if (_search.trim()) {
      const q = _search.toLowerCase();
      rows = rows.filter(r => r.panel_id.toLowerCase().includes(q));
    }
    rows = _sortRows(rows);

    const badge = Utils.el('scheduleBadge');
    if (badge) badge.textContent = rows.length;

    _renderTable(rows);
    if (typeof ScheduleCharts !== 'undefined') ScheduleCharts.update(rows);
  }

  function _sortRows(rows) {
    return [...rows].sort((a,b) => {
      let av = a[_sortKey], bv = b[_sortKey];
      if (av < bv) return _sortAsc ? -1 :  1;
      if (av > bv) return _sortAsc ?  1 : -1;
      return 0;
    });
  }

  function _renderTable(rows) {
    const tbody = Utils.el('scheduleTableBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No schedule data  run inspections first</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const dayCls = r.days_until <= 7  ? 'days-urgent'
                   : r.days_until <= 30 ? 'days-soon'
                   : 'days-ok';
      return `<tr><td><strong>${Utils.escHtml(r.panel_id)}</strong></td><td>${r.health != null ? Math.round(r.health)+'/100' : ''}</td><td>${Utils.fmtPct(r.soiling)}</td><td>${Utils.fmtWh(r.energy_loss)}</td><td><span class="priority-pill ${r.priority}">${r.priority}</span></td><td>${Utils.escHtml(r.clean_date)}</td><td class="${dayCls}">${r.days_until} days</td><td><button class="btn-outline btn-sm"
                  onclick="SchedulePage.markCleaned('${Utils.escHtml(r.panel_id)}')">Mark Cleaned</button></td></tr>`;
    }).join('');
  }

  function filter(val, btn) {
    _filter = val;
    document.querySelectorAll('#scheduleFilters .chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
    render();
  }

  function search(val) { _search = val; render(); }

  function sort(key) {
    if (_sortKey === key) _sortAsc = !_sortAsc;
    else { _sortKey = key; _sortAsc = true; }
    render();
  }

  function markCleaned(panelId) {
    const idx = _rows.findIndex(r => r.panel_id === panelId);
    if (idx >= 0) {
      _rows.splice(idx, 1);
      render();
      Toast.success(`${panelId} marked as cleaned`);
    }
  }

  function refresh() { _buildSchedule(); render(); Toast.info('Schedule refreshed'); }
  function resetSession() { showConfirmModal(); }
  function confirmReset()  { globalConfirmReset(); }

  return { init, render, filter, search, sort, markCleaned, refresh, resetSession, confirmReset };
})();

/* 
   20. WORK ORDERS PAGE
 */
const WorkOrdersPage = (() => {
  let _orders = [];
  let _filter = 'all';
  let _search = '';
  let _sortKey = 'created_at';
  let _sortAsc  = false;

  function init() {
    _buildOrders();
    render();
  }

  function _buildOrders() {
    const existing = _orders.filter(o => o.status === 'Completed');
    _orders = Session.getAll().flatMap((r, ri) =>(r.detections||[]).filter(d => d.priority === 'Critical' || d.priority === 'High')
        .map((d, di) => ({
          wo_id:      `WO-${String(ri+1).padStart(3,'0')}-${di+1}`,
          panel_id:   r.panel_id,
          issue:      d.class.replace(/_/g,' '),
          priority:   d.priority,
          status:     existing.find(o => o.panel_id===r.panel_id && o.issue===d.class.replace(/_/g,' '))?.status || 'Open',
          created_at: r.timestamp || Utils.ts(),
          insp_id:    r.id,
        }))
    );

    // KPI counts
    const open     = _orders.filter(o=>o.status==='Open');
    const done     = _orders.filter(o=>o.status==='Completed');
    const critOpen = open.filter(o=>o.priority==='Critical');
    const highOpen = open.filter(o=>o.priority==='High');

    Utils.setText('wo-total',     _orders.length);
    Utils.setText('wo-critical',  critOpen.length);
    Utils.setText('wo-high',      highOpen.length);
    Utils.setText('wo-completed', done.length);
    Utils.setText('wo-open',      open.length);
  }

  function render() {
    let rows = [..._orders];

    if (_filter === 'Open' || _filter === 'Completed') {
      rows = rows.filter(r => r.status === _filter);
    } else if (_filter !== 'all') {
      rows = rows.filter(r => r.priority === _filter);
    }

    if (_search.trim()) {
      const q = _search.toLowerCase();
      rows = rows.filter(r =>r.wo_id.toLowerCase().includes(q)    ||
        r.panel_id.toLowerCase().includes(q) ||
        r.issue.toLowerCase().includes(q)
      );
    }

    rows = _sortRows(rows);

    const badge = Utils.el('woBadge');
    if (badge) badge.textContent = rows.length;

    _renderTable(rows);
    if (typeof WorkOrderCharts !== 'undefined') WorkOrderCharts.update(_orders);
  }

  function _sortRows(rows) {
    return [...rows].sort((a,b) => {
      let av = a[_sortKey], bv = b[_sortKey];
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return _sortAsc ? -1 :  1;
      if (av > bv) return _sortAsc ?  1 : -1;
      return 0;
    });
  }

  function _renderTable(rows) {
    const tbody = Utils.el('woTableBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No work orders  run inspections to generate them automatically</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const statusCls = r.status === 'Completed' ? 'status-pill completed' : 'status-pill open';
      return `<tr><td><strong>${Utils.escHtml(r.wo_id)}</strong></td><td>${Utils.escHtml(r.panel_id)}</td><td>${Utils.escHtml(r.issue)}</td><td><span class="priority-pill ${r.priority}">${r.priority}</span></td><td><span class="${statusCls}">${r.status}</span></td><td>${Utils.escHtml(r.created_at)}</td><td>${r.status !== 'Completed'
            ? `<button class="btn-outline btn-sm" onclick="WorkOrdersPage.markDone('${Utils.escHtml(r.wo_id)}')"> Done</button>`
            : '<span style="color:var(--green-dark);font-size:.72rem"> Done</span>'
          }</td></tr>`;
    }).join('');
  }

  async function markDone(woId) {
    const o = _orders.find(x => x.wo_id === woId);
    if (!o) return;
    try { await API.markWODone(woId); } catch(e) {}
    o.status = 'Completed';
    _buildOrders();
    render();
    Toast.success(`Work order ${woId} completed`);
  }

  function markAllDone() {
    _orders.forEach(o => o.status = 'Completed');
    _buildOrders(); render();
    Toast.success('All work orders marked as completed');
  }

  function filter(val, btn) {
    _filter = val;
    document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
    render();
  }

  function search(val) { _search = val; render(); }

  function sort(key) {
    if (_sortKey === key) _sortAsc = !_sortAsc;
    else { _sortKey = key; _sortAsc = false; }
    render();
  }

  function exportCSV() { API.exportCSV(); }
  function refresh()   { _buildOrders(); render(); Toast.info('Work orders refreshed'); }
  function resetSession() { showConfirmModal(); }
  function confirmReset()  { globalConfirmReset(); }

  return { init, render, filter, search, sort, markDone, markAllDone,
           exportCSV, refresh, resetSession, confirmReset };
})();

/* 
   21. REPORT PAGE
 */
const ReportPage = (() => {

  function _videoGroup(result) {
    if (!result?.video_id) return null;
    const frames = Session.getAll()
      .filter(r => r.video_id === result.video_id)
      .sort((a,b) => (a.frame_index || 0) - (b.frame_index || 0));
    if (!frames.length) return null;
    const allDetections = frames.flatMap(r => r.detections || []);
    const energyLoss = frames.reduce((sum, r) => sum + (Number(r.energy_loss) || 0), 0);
    const avgHealth = frames.reduce((sum, r) => sum + (Number(r.health_score) || 0), 0) / frames.length;
    return { frames, allDetections, energyLoss, avgHealth, totalDefects: allDetections.length };
  }

  function _narrativeFor(result, group) {
    const dets = group ? group.allDetections : (result.detections || []);
    const counts = {};
    dets.forEach(d => {
      const name = String(d.class || 'defect').replace(/_/g, ' ');
      counts[name] = (counts[name] || 0) + 1;
    });
    const classSummary = Object.entries(counts).sort((a,b) => b[1] - a[1])
      .slice(0, 4).map(([name, count]) => `${name} (${count})`).join(', ') || 'no defects';
    if (group) {
      const weakest = group.frames.reduce((worst, r) => !worst || (r.health_score || 100) < (worst.health_score || 100) ? r : worst, null);
      const label = Utils.healthLabel(group.avgHealth);
      return `Drone video inspection completed across ${group.frames.length} analysed frame${group.frames.length === 1 ? '' : 's'}. ` +
        `The combined video health score is ${group.avgHealth.toFixed(1)}/100 (${label}), with ${group.totalDefects} total detected issue${group.totalDefects === 1 ? '' : 's'}: ${classSummary}. ` +
        `Estimated combined energy loss is ${Utils.fmtWh(group.energyLoss)} per cycle, so ROI and payback are calculated from all video frames together. ` +
        `Weakest frame/panel: ${weakest?.panel_id || result.panel_id} at ${Math.round(weakest?.health_score || result.health_score || 0)}/100. ` +
        `${group.avgHealth < 75 ? 'Schedule cleaning for the flagged panels and review the highest confidence detections first.' : 'System condition is acceptable; keep routine monitoring active.'}`;
    }
    return result.nlp_report || 'Inspection completed.';
  }

  function init() {
    const last = Session.getLatest();
    if (last) generate(last);
    else      _showEmpty();
    _renderPanelChips();
  }

  function generate(result) {
    result = result || Session.getLatest();
    if (!result) { _showEmpty(); Toast.warn('No inspections yet  run one first'); return; }

    Utils.el('reportEmptyState').style.display = 'none';
    Utils.el('reportContent').style.display    = '';

    // Header meta
    Utils.setText('rep-panelId',  result.panel_id  || '');
    Utils.setText('rep-date',     result.date       || Utils.dateStr());
    Utils.setText('rep-model',    (result.model||'').toUpperCase());
    Utils.setText('rep-location', result.location   || '');
    Utils.setText('rep-mode',     SS.session.simMode ? 'SIM MODE' : 'LIVE');

    // Health bar
    const fill  = Utils.el('repHealthFill');
    const score = result.health_score != null ? Math.round(result.health_score) : 0;
    if (fill) {
      setTimeout(() => { fill.style.width = score + '%'; }, 80);
      fill.style.background = Utils.healthColor(score);
    }
    Utils.setText('rep-healthVal',   score || '');
    const lbl = Utils.el('rep-healthLabel');
    if (lbl) { lbl.textContent = result.health_label || ''; lbl.className = 'report-health-label ' + (result.health_label||''); }

    const group = _videoGroup(result);

    // NLP report
    const nlp = Utils.el('rep-nlpText');
    if (nlp) nlp.textContent = _narrativeFor(result, group);
    if (nlp) nlp.textContent = result.nlp_report || '';

    if (nlp) nlp.textContent = _narrativeFor(result, group);

    // Annotated image
    const img    = Utils.el('rep-annotatedImg');
    const noImg  = Utils.el('rep-noImage');
    const reportImage = result.annotated_image || result.original_image;
    if (reportImage) {
      if (img)   { img.src = reportImage; img.style.display = 'block'; }
      if (noImg)   noImg.style.display = 'none';
    } else {
      if (img)   img.style.display = 'none';
      if (noImg) noImg.style.display = '';
    }

    // ROI blocks
    Utils.setText('rep-energyLoss', Utils.fmtWh(result.energy_loss));
    const roi = Utils.roiFromEnergyLoss(result.energy_loss, result.cycles_per_day || 3.44);
    Utils.setText('rep-lossHr',     Utils.fmtAUD(roi.hourlyAud));
    Utils.setText('rep-annualLoss', Utils.fmtAUD(roi.annualAud));
    Utils.setText('rep-cleanCost',  Utils.fmtAUD(SS.conf.cleanCost));
    Utils.setText('rep-payback',    roi.paybackDays ? roi.paybackDays + ' days' : '');
    Utils.setText('rep-cleanDate',  result.clean_date || '');

    const roiEnergyLoss = group ? group.energyLoss : result.energy_loss;
    const groupRoi = Utils.roiFromEnergyLoss(roiEnergyLoss, result.cycles_per_day || 3.44);
    Utils.setText('rep-energyLoss', Utils.fmtWh(roiEnergyLoss));
    Utils.setText('rep-lossHr',     Utils.fmtAUD(groupRoi.hourlyAud));
    Utils.setText('rep-annualLoss', Utils.fmtAUD(groupRoi.annualAud));
    Utils.setText('rep-payback',    groupRoi.paybackDays ? groupRoi.paybackDays + ' days' : '');

    Utils.setText('rep-payback',    groupRoi.paybackDays ? groupRoi.paybackDays + ' days' : '-');

    // Detections table
    _renderDetectionsTable(result.detections || []);

    // Per-panel summary
    _renderPanelTable(result);

    // Full session (all panels)
    _renderAllPanels();

    // Footer
    Utils.setText('rep-footerDate', Utils.dateStr());

    Toast.success('Report generated for ' + result.panel_id);
  }

  function _showEmpty() {
    const empty = Utils.el('reportEmptyState');
    const cont  = Utils.el('reportContent');
    if (empty) empty.style.display = '';
    if (cont)  cont.style.display  = 'none';
  }

  function _renderDetectionsTable(dets) {
    const tbody = Utils.el('rep-detectionsBody');
    const badge = Utils.el('rep-defectCount');
    if (badge) badge.textContent = dets.length;
    if (!tbody) return;
    if (!dets.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No defects detected </td></tr>';
      return;
    }
    tbody.innerHTML = dets.map((d,i) =>`<tr><td>${i+1}</td><td>${Utils.escHtml(d.class.replace(/_/g,' '))}</td><td>${(d.confidence*100).toFixed(1)}%</td><td><span class="priority-pill ${d.priority}">${d.priority}</span></td><td style="font-size:.68rem;color:var(--dark-4)">[${(d.bbox||[]).join(', ')}]</td></tr>`
    ).join('');
  }

  function _renderPanelTable(r) {
    const tbody = Utils.el('rep-panelBody');
    if (!tbody) return;
    const { date, days } = Utils.cleanDate(r.health_score||100);
    tbody.innerHTML = `<tr><td><strong>${Utils.escHtml(r.panel_id||'')}</strong></td><td style="font-weight:700">${r.health_score != null ? Math.round(r.health_score) : ''}/100</td><td><span class="priority-pill ${r.health_label||''}" style="font-size:.62rem">${Utils.escHtml(r.health_label||'')}</span></td><td>${Utils.fmtPct(r.soiling_pct)}</td><td>${Utils.fmtWh(r.energy_loss)}</td><td>${r.total_defects ?? 0}</td><td>${Utils.escHtml(date)}</td><td>${days} days</td></tr>`;
  }

  function _renderAllPanels() {
    const all  = Session.getAll();
    const card = Utils.el('rep-allPanelsCard');
    const body = Utils.el('rep-allPanelsBody');
    const cnt  = Utils.el('rep-allPanelCount');
    if (!card || !body) return;
    if (all.length < 2) { card.style.display='none'; return; }
    card.style.display = '';
    if (cnt) cnt.textContent = all.length;
    body.innerHTML = all.map(r => {
      const cls   = (r.health_label||'good').toLowerCase();
      const score = r.health_score != null ? Math.round(r.health_score) : '';
      const { date, days } = Utils.cleanDate(r.health_score||100);
      return `<div class="all-panel-row ${cls}"><span class="apr-id">${Utils.escHtml(r.panel_id)}</span><span class="apr-health" style="color:${Utils.healthColor(r.health_score||100)}">${score}/100</span><span class="apr-label priority-pill ${r.health_label||''}">${Utils.escHtml(r.health_label||'')}</span><span class="apr-soiling"> ${Utils.fmtPct(r.soiling_pct)}</span><span class="apr-energy"> ${Utils.fmtWh(r.energy_loss)}</span><span class="apr-defects"> ${r.total_defects ?? 0} defects</span><span class="apr-clean"> ${Utils.escHtml(date)} (${days}d)</span></div>`;
    }).join('');
  }

  function _renderPanelChips() {
    const all   = Session.getAll();
    const chips = Utils.el('panelSelectorChips');
    const sel   = Utils.el('reportPanelSelector');
    if (!chips || !sel) return;
    if (all.length < 2) { sel.style.display='none'; return; }
    sel.style.display = '';
    chips.innerHTML = all.map((r,i) =>`<span class="panel-selector-chip ${i===0?'active':''}"
             onclick="ReportPage.selectPanel(${i})">${Utils.escHtml(r.panel_id)}<span class="psc-health">${r.health_score != null ? Math.round(r.health_score) : ''}</span></span>`
    ).join('');
  }

  function selectPanel(idx) {
    document.querySelectorAll('.panel-selector-chip').forEach((c,i) =>c.classList.toggle('active', i===idx)
    );
    generate(Session.getAll()[idx]);
  }

  function copyNLP() {
    const txt = Utils.el('rep-nlpText')?.textContent || '';
    navigator.clipboard.writeText(txt).then(() => Toast.success('Report copied to clipboard'));
  }

  function printReport() {
    window.print();
  }

  function resetSession() { showConfirmModal(); }
  function confirmReset()  { globalConfirmReset(); }

  return { init, generate, selectPanel, copyNLP, printReport, resetSession, confirmReset };
})();


/* 
   BROADCAST  called after every inspection to sync all pages
 */
function broadcastResult(result) {
  // Dashboard
  if (typeof Dashboard !== 'undefined') {
    Dashboard.showResult(result);
  }
  // Results page
  if (typeof ResultsPage !== 'undefined') {
    ResultsPage.render();
  }
  // Farm overview
  if (typeof FarmOverview !== 'undefined') {
    FarmOverview.init();
  }
  // Schedule
  if (typeof SchedulePage !== 'undefined') {
    SchedulePage.init();
  }
  // Work Orders
  if (typeof WorkOrdersPage !== 'undefined') {
    WorkOrdersPage.init();
  }
  // Report page  auto-generate with latest result
  if (typeof ReportPage !== 'undefined') {
    ReportPage.init();
  }
  // Analytics
  if (typeof AnalyticsPage !== 'undefined') {
    AnalyticsPage.init();
    const all = Session.getAll();
    if (typeof AnalyticsCharts !== 'undefined' && all.length) {
      AnalyticsCharts.renderAll(all);
    }
  }
  // Intel bar + sidebar
  if (typeof IntelBar   !== 'undefined') IntelBar.update();
  if (typeof Sidebar    !== 'undefined') Sidebar.updateSessionStats();
  if (typeof HistoryBar !== 'undefined') HistoryBar.render();
}
window.broadcastResult = broadcastResult;

/* 
   22. EXPOSE GLOBALS for inline HTML onclick handlers
 */
window.SS             = SS;
window.Utils          = Utils;
window.Log            = Log;
window.Toast          = Toast;
window.API            = API;
window.Session        = Session;
window.IntelBar       = IntelBar;
window.Sidebar        = Sidebar;
window.HistoryBar     = HistoryBar;
window.Router         = Router;
window.SimData        = SimData;
window.PanelApp       = PanelApp;
window.Dashboard      = Dashboard;
window.AnalyticsPage  = AnalyticsPage;
window.ResultsPage    = ResultsPage;
window.FarmOverview   = FarmOverview;
window.SchedulePage   = SchedulePage;
window.WorkOrdersPage = WorkOrdersPage;
window.ReportPage     = ReportPage;
window.showConfirmModal  = showConfirmModal;
window.hideConfirmModal  = hideConfirmModal;
window.globalConfirmReset= globalConfirmReset;

/* Analytics / ScheduleCharts / WorkOrderCharts / FarmCharts
   are defined in charts.js and auto-init when that file loads */


/* 
     SOLARVISION MASTER PATCH  v3                            
     Fixes all wiring: KPIs, Gauge, Charts, Reset,            
     Report, Farm blank, broadcastResult, Router              
    */
(function () {
  'use strict';

  /*  1. Dashboard.showResult  update everything  */
  var _origDS = Dashboard.showResult.bind(Dashboard);
  Dashboard.showResult = function (r) {
    if (typeof Session !== 'undefined' && Session.normalizeResult) r = Session.normalizeResult(r);
    _origDS(r);
    if (!r) return;
    var all  = Session.getAll().map(function(x){ return Session.normalizeResult ? Session.normalizeResult(x) : x; });
    var avgH = all.length ? all.reduce(function(s,x){return s+(x.health_score||0);},0)/all.length : null;
    var totE = all.reduce(function(s,x){return s+(x.energy_loss||0);},0);
    var totD = all.reduce(function(s,x){return s+(x.total_defects||0);},0);
    var avgS = all.length ? all.reduce(function(s,x){return s+(x.soiling_pct||0);},0)/all.length : null;
    // KPI cards
    Utils.setText('kpi-health',  avgH!=null ? Math.round(avgH) : '');
    Utils.setText('kpi-soiling', avgS!=null ? avgS.toFixed(1)+'%'     : '');
    Utils.setText('kpi-energy',  totE       ? totE.toFixed(1)+' Wh'   : '');
    Utils.setText('kpi-defects', totD || '');
    Utils.setText('kpi-panels',  all.length || '');
    // Gauge
    Utils.setText('gaugeScore', Math.round(r.health_score||0));
    Utils.setText('gaugeLabel', r.health_label||'');
    var gc = document.getElementById('gaugeCanvas') || document.getElementById('healthGauge');
    if (gc && typeof GaugeChart !== 'undefined') GaugeChart.animate(gc.id, r.health_score||0);
    // Stage 1 stats
    Utils.setText('s1-model',   (r.model||'').toUpperCase());
    Utils.setText('s1-dets',    (r.stage1 || {}).used_crop ? '1 panel' : ((r.stage1 || {}).enabled === false ? 'SIM' : (r.total_defects != null ? r.total_defects : '')));
    Utils.setText('s1-health',  r.health_score  != null ? Math.round(r.health_score) : '');
    Utils.setText('s1-energy',  r.energy_loss   != null ? r.energy_loss.toFixed(1)+' Wh'   : '');
    Utils.setText('s1-soiling', r.soiling_pct   != null ? r.soiling_pct.toFixed(1)+'%'     : '');
    // Image meta bar
    Utils.setText('imgModel', (r.model||'').toUpperCase());
    Utils.setText('imgDate',  r.date||'');
    Utils.setText('imgSpeed', (r.inference_ms!=null ? r.inference_ms : '')+'ms');
    // Sparkline trend is only for legacy mini canvases. DashCharts owns dashTrendChart.
    var sp = document.getElementById('healthTrendMini');
    if (sp && typeof Sparkline !== 'undefined') {
      var sc = Session.getAll().map(function(x){return x.health_score||0;}).reverse();
      if (sc.length >= 1) Sparkline.draw(sp.id, sc);
    }
    // DashCharts (donut, confhist, priority already called in _origDS but call again to ensure)
    if (typeof DashCharts !== 'undefined') DashCharts.update(r);
  };

  /*  2. broadcastResult  sync ALL pages  */
  window.broadcastResult = function (r) {
    Dashboard.showResult(r);
    setTimeout(function () {
      if (typeof ResultsPage    !== 'undefined') ResultsPage.render();
      if (typeof FarmOverview   !== 'undefined') FarmOverview.init();
      if (typeof SchedulePage   !== 'undefined') SchedulePage.init();
      if (typeof WorkOrdersPage !== 'undefined') WorkOrdersPage.init();
      if (typeof ReportPage     !== 'undefined') ReportPage.init();
      if (typeof AnalyticsPage  !== 'undefined') {
        AnalyticsPage.init();
        var all2 = Session.getAll();
        if (typeof AnalyticsCharts !== 'undefined' && all2.length) AnalyticsCharts.renderAll(all2);
      }
      if (typeof IntelBar  !== 'undefined') IntelBar.update();
      if (typeof Sidebar   !== 'undefined') Sidebar.updateSessionStats();
      if (typeof HistoryBar!== 'undefined') HistoryBar.render();
    }, 180);
  };

  /*  3. Wire broadcastResult into PanelApp.runInspection  */
  var _origRun = PanelApp.runInspection.bind(PanelApp);
  PanelApp.runInspection = async function () {
    await _origRun();
    var l = Session.getLatest();
    if (l) window.broadcastResult(l);
  };

  /*  4. Wire broadcastResult into PanelApp.analyzeVideo  */
  var _origVid = PanelApp.analyzeVideo.bind(PanelApp);
  PanelApp.analyzeVideo = async function () {
    await _origVid();
    var l = Session.getLatest();
    if (l) window.broadcastResult(l);
  };

  /*  5. Router.goTo  re-render on navigate  */
  var _origGoTo = Router.goTo.bind(Router);
  Router.goTo = function (pageId) {
    _origGoTo(pageId);
    var all3 = Session.getAll();
    setTimeout(function () {
      if (pageId === 'dashboard'  && all3.length && typeof Dashboard      !== 'undefined') Dashboard.showResult(Session.getLatest());
      if (pageId === 'results'    && typeof ResultsPage    !== 'undefined') ResultsPage.render();
      if (pageId === 'farm'       && typeof FarmOverview   !== 'undefined') FarmOverview.init();
      if (pageId === 'schedule'   && typeof SchedulePage   !== 'undefined') SchedulePage.init();
      if (pageId === 'workorders' && typeof WorkOrdersPage !== 'undefined') WorkOrdersPage.init();
      if (pageId === 'report'     && typeof ReportPage     !== 'undefined') ReportPage.init();
      if (pageId === 'analytics'  && typeof AnalyticsPage  !== 'undefined') {
        AnalyticsPage.init();
        if (typeof AnalyticsCharts !== 'undefined' && all3.length) AnalyticsCharts.renderAll(all3);
      }
    }, 80);
  };

  /*  6. Farm  start blank, only inspected panels show score  */
  var _origFarmInit = FarmOverview.init.bind(FarmOverview);
  var _patchedFarm  = false;
  FarmOverview.init = function () {
    if (!_patchedFarm) {
      _patchedFarm = true;
      var _origGenFarm = SimData.generateFarm.bind(SimData);
      SimData.generateFarm = function (n) {
        return _origGenFarm(n).map(function (p) {
          return Object.assign({}, p, {
            health_score: null, health_label: 'uninspected',
            energy_loss: 0, soiling_pct: 0, defects: 0, inspected: false
          });
        });
      };
    }
    _origFarmInit();
  };

  /*  7. Reset + Report buttons  */
  window.showConfirmModal   = function () { var m=document.getElementById('confirmModal'); if(m) m.style.display='flex'; };
  window.hideConfirmModal   = function () { var m=document.getElementById('confirmModal'); if(m) m.style.display='none'; };
  window.globalConfirmReset = function () { Session.reset(); window.hideConfirmModal(); location.reload(); };

  /*  8. Auto-restore session on load  */
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof Session !== 'undefined') Session.load();
    var saved = (typeof Session !== 'undefined') ? Session.getAll() : [];
    if (saved.length) {
      setTimeout(function () {
        var latest = Session.getLatest();
        if (latest && typeof Dashboard !== 'undefined') Dashboard.showResult(latest);
        if (typeof ResultsPage   !== 'undefined') ResultsPage.render();
        if (typeof AnalyticsPage !== 'undefined') {
          AnalyticsPage.init();
          if (typeof AnalyticsCharts !== 'undefined') AnalyticsCharts.renderAll(saved);
        }
      }, 400);
    }
  });

})();
/* END SOLARVISION MASTER PATCH */

