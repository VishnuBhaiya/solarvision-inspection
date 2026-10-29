/* 
   SOLARVISION  dashboard.js
   Chart.js chart instances for Dashboard page:
   Donut (class dist)  Trend (health over time) 
   Confidence histogram  Priority bar
   Also: DashCharts, AnalyticsCharts, FarmCharts,
         ScheduleCharts, WorkOrderCharts
 */

'use strict';

/*  Shared palette  */
const PALETTE = {
  amber:   '#f59e0b',
  amberL:  'rgba(245,158,11,.15)',
  red:     '#ef4444',
  redL:    'rgba(239,68,68,.15)',
  orange:  '#f97316',
  orangeL: 'rgba(249,115,22,.15)',
  green:   '#22c55e',
  greenL:  'rgba(34,197,94,.15)',
  yellow:  '#eab308',
  blue:    '#3b82f6',
  purple:  '#8b5cf6',
  pink:    '#ec4899',
  teal:    '#0ea5e9',
  slate:   '#6b7280',
  brown:   '#b45309',
  dark:    '#1c1917',
  cream:   '#f8f6f1',
  border:  '#e5e0d8',
};

const CLASS_COLORS = {
  soiling:          PALETTE.amber,
  physical_damage:  PALETTE.red,
  bird_dropping:    PALETTE.purple,
  hotspot:          PALETTE.orange,
  shadow:           PALETTE.slate,
  burn_mark:        '#dc2626',
  delamination:     PALETTE.teal,
  discoloration:    PALETTE.pink,
  crack:            PALETTE.brown,
};

const PRIORITY_COLORS = {
  Critical: PALETTE.red,
  High:     PALETTE.orange,
  Medium:   PALETTE.yellow,
  Low:      PALETTE.green,
};

/*  Chart.js global defaults  */
function _applyDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family      = "'Inter', 'system-ui', sans-serif";
  Chart.defaults.font.size        = 11;
  Chart.defaults.color            = '#78716c';
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.padding  = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1c1917';
  Chart.defaults.plugins.tooltip.titleColor      = '#fff';
  Chart.defaults.plugins.tooltip.bodyColor       = '#d6d3d1';
  Chart.defaults.plugins.tooltip.padding         = 10;
  Chart.defaults.plugins.tooltip.cornerRadius    = 8;
}

/*  Destroy helper  */
const _charts = {};
function _destroy(key) {
  if (_charts[key]) { _charts[key].destroy(); delete _charts[key]; }
}
function _getCtx(id) {
  const el = document.getElementById(id);
  if (el && typeof Chart !== 'undefined' && Chart.getChart) {
    const existing = Chart.getChart(el);
    if (existing) existing.destroy();
  }
  return el ? el.getContext('2d') : null;
}

/* 
   DASH CHARTS  live dashboard page charts
 */
const DashCharts = (() => {

  function update(result) {
    if (typeof Chart === 'undefined') return;
    _applyDefaults();
    _drawClassDonut(result);
    _drawConfHist(result);
    _drawPriorityBar(result);
    _drawHealthTrendMini();
  }

  /* Class distribution donut */
  function _drawClassDonut(r) {
    const dets = r.detections || [];
    _destroy('dashDonut');
    const ctx = _getCtx('dashDonutChart');
    if (!ctx) return;

    if (!dets.length) return;

    const counts = {};
    dets.forEach(d => counts[d.class] = (counts[d.class]||0) + 1);
    const labels = Object.keys(counts);
    const data   = labels.map(k => counts[k]);
    const colors = labels.map(k => CLASS_COLORS[k] || PALETTE.amber);

    _charts['dashDonut'] = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { font: { size:10 } } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} detection${ctx.parsed>1?'s':''}` } },
        },
      },
    });
  }

  /* Confidence histogram */
  function _drawConfHist(r) {
    const dets = r.detections || [];
    _destroy('dashConfHist');
    const ctx = _getCtx('dashConfHistChart');
    if (!ctx || !dets.length) return;

    const labels = dets.map(d => d.class.replace(/_/g,' ').slice(0,12));
    const confs  = dets.map(d => parseFloat((d.confidence*100).toFixed(1)));
    const colors = dets.map(d => PRIORITY_COLORS[d.priority] || PALETTE.amber);

    _charts['dashConfHist'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Confidence %',
          data: confs,
          backgroundColor: colors.map(c => c + 'cc'),
          borderColor: colors,
          borderWidth: 1.5,
          borderRadius: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { min:0, max:100, grid: { color: PALETTE.border },
               ticks: { callback: v => v+'%' } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  /* Priority bar */
  function _drawPriorityBar(r) {
    const dets = r.detections || [];
    _destroy('dashPriorityBar');
    const ctx = _getCtx('dashPriorityChart');
    if (!ctx) return;

    const counts = { Critical:0, High:0, Medium:0, Low:0 };
    dets.forEach(d => { if (counts[d.priority] !== undefined) counts[d.priority]++; });

    _charts['dashPriorityBar'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Critical','High','Medium','Low'],
        datasets: [{
          data:            Object.values(counts),
          backgroundColor: Object.keys(counts).map(k => PRIORITY_COLORS[k] + 'cc'),
          borderColor:     Object.keys(counts).map(k => PRIORITY_COLORS[k]),
          borderWidth: 1.5,
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero:true, grid: { color: PALETTE.border }, ticks: { stepSize:1 } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  /* Mini health trend  last N inspections */
  function _drawHealthTrendMini() {
    _destroy('dashTrend');
    const ctx = _getCtx('dashTrendChart');
    if (!ctx) return;
    const all    = (typeof Session !== 'undefined' ? Session.getAll() : []).slice().reverse();
    if (all.length < 2) return;
    const labels = all.map(r => r.panel_id);
    const data   = all.map(r => r.health_score || 0);

    _charts['dashTrend'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Health Score',
          data,
          borderColor:     PALETTE.amber,
          backgroundColor: PALETTE.amberL,
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: PALETTE.amber,
          tension: 0.35,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { min:0, max:100, grid: { color: PALETTE.border }, ticks: { callback: v=>v+'' } },
          x: { grid: { display: false }, ticks: { maxRotation:0, maxTicksLimit:8 } },
        },
      },
    });
  }

  return { update };
})();

/* 
   ANALYTICS CHARTS  analytics page
 */
const AnalyticsCharts = (() => {

  function renderAll(inspections) {
    if (typeof Chart === 'undefined') return;
    _applyDefaults();
    _healthTrend(inspections);
    _defectFreq(inspections);
    _energyTimeline(inspections);
    _confHist(inspections);
    _priorityDonut(inspections);
    _panelHealthDist(inspections);
    setTimeout(() => {
      Object.values(_charts).forEach(ch => {
        if (ch && typeof ch.resize === 'function') ch.resize();
      });
    }, 80);
  }

  /* 1  Health score trend over time */
  function _healthTrend(data) {
    _destroy('anHealthTrend');
    const ctx = _getCtx('healthTrendChart');
    if (!ctx || !data.length) return;

    _charts['anHealthTrend'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(r => r.panel_id),
        datasets: [{
          label: 'Health Score',
          data:  data.map(r => r.health_score||0),
          borderColor: PALETTE.amber,
          backgroundColor: PALETTE.amberL,
          borderWidth: 2, pointRadius: 4,
          pointBackgroundColor: data.map(r =>(r.health_score||0) < 35 ? PALETTE.red :
            (r.health_score||0) < 55 ? PALETTE.orange : PALETTE.green
          ),
          tension: 0.3, fill: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { min:0, max:100, grid:{color:PALETTE.border}, ticks:{callback:v=>v+'/100'} },
          x: { grid:{display:false}, ticks:{maxTicksLimit:10, maxRotation:30} },
        },
      },
    });
  }

  /* 2  Defect frequency bar */
  function _defectFreq(data) {
    _destroy('anDefectFreq');
    const ctx = _getCtx('defectFreqChart');
    if (!ctx || !data.length) return;

    const counts = {};
    data.forEach(r => (r.detections||[]).forEach(d => {
      counts[d.class] = (counts[d.class]||0)+1;
    }));
    const sorted  = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    const labels  = sorted.map(([k])=>k.replace(/_/g,' '));
    const values  = sorted.map(([,v])=>v);
    const colors  = sorted.map(([k])=> (CLASS_COLORS[k]||PALETTE.amber)+'cc');
    const borders = sorted.map(([k])=> CLASS_COLORS[k]||PALETTE.amber);

    _charts['anDefectFreq'] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label:'Detections', data:values,
        backgroundColor:colors, borderColor:borders, borderWidth:1.5, borderRadius:5 }] },
      options: {
        indexAxis: 'y',
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{
          x:{ beginAtZero:true, grid:{color:PALETTE.border}, ticks:{stepSize:1} },
          y:{ grid:{display:false} },
        },
      },
    });
  }

  /* 3  Energy loss timeline */
  function _energyTimeline(data) {
    _destroy('anEnergyLine');
    const ctx = _getCtx('energyTimelineChart');
    if (!ctx || !data.length) return;

    const cumulative = data.reduce((acc,r,i) => {
      acc.push((acc[i-1]||0) + (r.energy_loss||0));
      return acc;
    }, []);

    _charts['anEnergyLine'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(r=>r.panel_id),
        datasets: [
          {
            label: 'Per Inspection (Wh)',
            data:  data.map(r=>r.energy_loss||0),
            borderColor: PALETTE.orange,
            backgroundColor: PALETTE.orangeL,
            borderWidth:2, pointRadius:3, tension:0.3, fill:true, yAxisID:'y',
          },
          {
            label: 'Cumulative (Wh)',
            data:  cumulative,
            borderColor: PALETTE.red,
            borderDash: [4,4],
            borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, yAxisID:'y1',
          },
        ],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:true, position:'top' } },
        scales: {
          y:  { beginAtZero:true, grid:{color:PALETTE.border}, ticks:{callback:v=>v+'Wh'}, title:{display:true,text:'Per Inspection'} },
          y1: { beginAtZero:true, position:'right', grid:{display:false}, ticks:{callback:v=>v+'Wh'}, title:{display:true,text:'Cumulative'} },
          x:  { grid:{display:false}, ticks:{maxTicksLimit:10, maxRotation:30} },
        },
      },
    });
  }

  /* 4  Confidence histogram across all inspections */
  function _confHist(data) {
    _destroy('anConfHist');
    const ctx = _getCtx('confHistChart') || _getCtx('dashConfHistChart');
    if (!ctx || !data.length) return;

    const buckets = [0,0,0,0,0]; // 0-20,20-40,40-60,60-80,80-100
    data.forEach(r => (r.detections||[]).forEach(d => {
      const b = Math.min(4, Math.floor(d.confidence * 5));
      buckets[b]++;
    }));
    const labels = ['020%','2040%','4060%','6080%','80100%'];
    const colors = [PALETTE.red, PALETTE.orange, PALETTE.yellow, PALETTE.amber, PALETTE.green];

    _charts['anConfHist'] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label:'# Detections', data:buckets,
        backgroundColor:colors.map(c=>c+'bb'), borderColor:colors, borderWidth:1.5, borderRadius:5 }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{
          y:{ beginAtZero:true, grid:{color:PALETTE.border}, ticks:{stepSize:1} },
          x:{ grid:{display:false} },
        },
      },
    });
  }

  /* 5  Priority donut across all */
  function _priorityDonut(data) {
    _destroy('anPriorityDonut');
    const ctx = _getCtx('priorityDonutChart') || _getCtx('dashPriorityChart');
    if (!ctx || !data.length) return;

    const counts = { Critical:0, High:0, Medium:0, Low:0 };
    data.forEach(r => (r.detections||[]).forEach(d => {
      if (counts[d.priority] !== undefined) counts[d.priority]++;
    }));
    const labels = Object.keys(counts);
    const values = Object.values(counts);
    const colors = labels.map(k => PRIORITY_COLORS[k]||PALETTE.amber);

    _charts['anPriorityDonut'] = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data:values,
        backgroundColor:colors.map(c=>c+'cc'), borderColor:colors, borderWidth:2, hoverOffset:6 }] },
      options: {
        responsive:true, maintainAspectRatio:true,
        cutout:'58%',
        plugins:{ legend:{ position:'bottom' } },
      },
    });
  }

  /* 6  Panel health distribution scatter */
  function _panelHealthDist(data) {
    _destroy('anPanelDist');
    const ctx = _getCtx('panelHealthDistChart');
    if (!ctx || !data.length) return;

    const points = data.map((r,i) => ({
      x: i+1,
      y: r.health_score||0,
    }));

    _charts['anPanelDist'] = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Health Score',
          data: points,
          backgroundColor: data.map(r =>(r.health_score||0) < 35 ? PALETTE.red+'cc' :
            (r.health_score||0) < 55 ? PALETTE.orange+'cc' :
            (r.health_score||0) < 75 ? PALETTE.yellow+'cc' :
            PALETTE.green+'cc'
          ),
          pointRadius: 6,
          pointHoverRadius: 9,
        }],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins: { legend:{ display:false },
          tooltip:{ callbacks:{ label: c => `${data[c.dataIndex]?.panel_id}: ${c.parsed.y}/100` } } },
        scales:{
          y:{ min:0, max:100, grid:{color:PALETTE.border}, ticks:{callback:v=>v+'/100'} },
          x:{ grid:{display:false}, ticks:{callback:(_,i)=>data[i]?.panel_id||''} },
        },
      },
    });
  }

  return { renderAll };
})();

/* 
   FARM CHARTS  farm overview page
 */
const FarmCharts = (() => {

  function updateHealthDist(panels) {
    _destroy('farmHealthDist');
    const canvasId = document.getElementById('farmHealthDistChart') ? 'farmHealthDistChart' : 'dashPriorityChart';
    const ctx = _getCtx(canvasId);
    if (!ctx || typeof Chart === 'undefined') return;

    const buckets = { Excellent:0, Good:0, Moderate:0, Poor:0, Critical:0 };
    panels.forEach(p => {
      const lbl = (typeof Utils!=='undefined') ? Utils.healthLabel(p.health_score||100) : 'Good';
      if (buckets[lbl] !== undefined) buckets[lbl]++;
    });

    _charts['farmHealthDist'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: Object.keys(buckets),
        datasets: [{
          data: Object.values(buckets),
          backgroundColor: [
            PALETTE.green+'cc', '#4ade80cc', PALETTE.yellow+'cc',
            PALETTE.orange+'cc', PALETTE.red+'cc'
          ],
          borderColor: [PALETTE.green,'#4ade80',PALETTE.yellow,PALETTE.orange,PALETTE.red],
          borderWidth:1.5, borderRadius:5,
        }],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{
          y:{ beginAtZero:true, grid:{color:PALETTE.border}, ticks:{stepSize:1} },
          x:{ grid:{display:false} },
        },
      },
    });
  }

  return { updateHealthDist };
})();

/* 
   SCHEDULE CHARTS  schedule page
 */
const ScheduleCharts = (() => {

  function update(rows) {
    _destroy('scheduleTimeline');
    _destroy('scheduleUrgency');
    if (typeof Chart === 'undefined') return;
    _applyDefaults();

    const timelineCtx = _getCtx('scheduleTimelineChart');
    const urgencyCtx = _getCtx('scheduleUrgencyChart') || _getCtx('schedPriorityChart');
    const hasRows = rows && rows.length;

    const timelineEmpty = document.getElementById('scheduleTimelineEmpty');
    const urgencyEmpty = document.getElementById('scheduleUrgencyEmpty');
    if (timelineEmpty) timelineEmpty.classList.toggle('visible', !hasRows);
    if (urgencyEmpty) urgencyEmpty.classList.toggle('visible', !hasRows);
    if (!hasRows) return;

    const sorted = [...rows].sort((a,b) => (a.days_until || 0) - (b.days_until || 0));
    if (timelineCtx) {
      _charts['scheduleTimeline'] = new Chart(timelineCtx, {
        type: 'bar',
        data: {
          labels: sorted.map(r => r.panel_id),
          datasets: [{
            label: 'Days until clean',
            data: sorted.map(r => r.days_until || 0),
            backgroundColor: sorted.map(r =>(r.days_until || 0) <= 7 ? PALETTE.orange + 'cc' :
              (r.days_until || 0) <= 30 ? PALETTE.yellow + 'cc' :
              PALETTE.green + 'cc'
            ),
            borderColor: sorted.map(r =>(r.days_until || 0) <= 7 ? PALETTE.orange :
              (r.days_until || 0) <= 30 ? PALETTE.yellow :
              PALETTE.green
            ),
            borderWidth: 1.5,
            borderRadius: 6,
          }],
        },
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{ display:false } },
          scales:{
            y:{ beginAtZero:true, grid:{color:PALETTE.border}, ticks:{callback:v=>v+'d'} },
            x:{ grid:{display:false} },
          },
        },
      });
    }

    const counts = { High:0, Medium:0, Low:0 };
    rows.forEach(r => { if (counts[r.priority]!==undefined) counts[r.priority]++; });

    if (!urgencyCtx) return;
    _charts['scheduleUrgency'] = new Chart(urgencyCtx, {
      type: 'doughnut',
      data: {
        labels: ['High','Medium','Low'],
        datasets: [{
          data: [counts.High, counts.Medium, counts.Low],
          backgroundColor: [PALETTE.orange+'cc', PALETTE.yellow+'cc', PALETTE.green+'cc'],
          borderColor:     [PALETTE.orange, PALETTE.yellow, PALETTE.green],
          borderWidth:2, hoverOffset:6,
        }],
      },
      options: {
        responsive:true, maintainAspectRatio:true,
        cutout:'55%',
        plugins:{ legend:{ position:'bottom' } },
      },
    });
  }

  return { update };
})();

/* 
   WORK ORDER CHARTS  work orders page
 */
const WorkOrderCharts = (() => {

  function update(orders) {
    _destroy('woStatusDonut');
    _destroy('woIssueBreakdown');
    const ctx1 = _getCtx('woStatusChart');
    const ctx2 = _getCtx('woIssueChart') || _getCtx('woPriorityChart');
    if (typeof Chart === 'undefined') return;
    _applyDefaults();

    const statusEmpty = document.getElementById('woStatusEmpty');
    const issueEmpty = document.getElementById('woIssueEmpty');
    if (statusEmpty) statusEmpty.classList.toggle('visible', !orders.length);
    if (issueEmpty) issueEmpty.classList.toggle('visible', !orders.length);

    // Status donut
    if (ctx1 && orders.length) {
      const open = orders.filter(o=>o.status==='Open').length;
      const done = orders.length - open;
      _charts['woStatusDonut'] = new Chart(ctx1, {
        type: 'doughnut',
        data: {
          labels: ['Open','Completed'],
          datasets: [{
            data: [open, done],
            backgroundColor: [PALETTE.orange+'cc', PALETTE.green+'cc'],
            borderColor:     [PALETTE.orange, PALETTE.green],
            borderWidth:2, hoverOffset:4,
          }],
        },
        options: {
          responsive:true, maintainAspectRatio:true,
          cutout:'60%',
          plugins:{ legend:{ position:'bottom' } },
        },
      });
    }

    // Issue breakdown
    if (ctx2 && orders.length) {
      const issueCounts = {};
      orders.forEach(o => {
        const key = o.issue || 'unknown';
        issueCounts[key] = (issueCounts[key] || 0) + 1;
      });
      const entries = Object.entries(issueCounts).sort((a,b) => b[1] - a[1]);
      _charts['woIssueBreakdown'] = new Chart(ctx2, {
        type: 'bar',
        data: {
          labels: entries.map(([k]) => k),
          datasets: [{
            data: entries.map(([,v]) => v),
            backgroundColor: entries.map(([k]) => (CLASS_COLORS[k.replace(/\s+/g,'_')] || PALETTE.amber) + 'cc'),
            borderColor:     entries.map(([k]) => CLASS_COLORS[k.replace(/\s+/g,'_')] || PALETTE.amber),
            borderWidth:1.5, borderRadius:5,
          }],
        },
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{ display:false } },
          scales:{
            y:{ beginAtZero:true, grid:{color:PALETTE.border}, ticks:{stepSize:1} },
            x:{ grid:{display:false}, ticks:{maxRotation:0} },
          },
        },
      });
    }
  }

  return { update };
})();

/* 
   EXPOSE GLOBALS
 */
window.DashCharts      = DashCharts;
window.AnalyticsCharts = AnalyticsCharts;
window.FarmCharts      = FarmCharts;
window.ScheduleCharts  = ScheduleCharts;
window.WorkOrderCharts = WorkOrderCharts;


/* 
   GAUGE CHART
 */
const GaugeChart = (() => {
  function animate(canvasId, score) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cx = w/2, cy = h*0.85, r = Math.min(w, h*1.6)*0.42;
    const pct = Math.max(0, Math.min(100, score)) / 100;
    const color = score>=85?'#22c55e':score>=65?'#f59e0b':score>=40?'#f97316':'#ef4444';
    let progress = 0;
    const step = pct / 30;
    function draw(cur) {
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath(); ctx.arc(cx,cy,r,Math.PI,2*Math.PI);
      ctx.lineWidth=14; ctx.strokeStyle='#1e1e2e'; ctx.lineCap='round'; ctx.stroke();
      if (cur > 0) {
        ctx.beginPath(); ctx.arc(cx,cy,r,Math.PI, Math.PI + Math.PI*cur);
        ctx.lineWidth=14; ctx.strokeStyle=color; ctx.lineCap='round'; ctx.stroke();
      }
    }
    function frame() {
      progress = Math.min(progress + step, pct);
      draw(progress);
      if (progress < pct) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  return { animate };
})();

/* 
   SPARKLINE  mini trend line
 */
const Sparkline = (() => {
  const _ch = {};
  function draw(canvasId, values) {
    const el = document.getElementById(canvasId);
    if (!el || !values.length || typeof Chart === 'undefined') return;
    if (_ch[canvasId]) { _ch[canvasId].destroy(); }
    _ch[canvasId] = new Chart(el.getContext('2d'), {
      type: 'line',
      data: {
        labels: values.map((_,i) => 'S'+(i+1)),
        datasets: [{
          data: values,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.08)',
          borderWidth: 2,
          pointRadius: values.length > 8 ? 0 : 3,
          pointBackgroundColor: '#f59e0b',
          tension: 0.4,
          fill: true,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: true } },
        scales: {
          y: { min:0, max:100, grid: { color:'rgba(255,255,255,0.05)' }, ticks: { color:'#888', maxTicksLimit:4 } },
          x: { grid: { display:false }, ticks: { color:'#888', maxTicksLimit:6 } }
        }
      }
    });
  }
  return { draw };
})();
