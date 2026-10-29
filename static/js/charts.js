/* ═══════════════════════════════════════════════════════════════
   SOLARVISION — charts.js
   Gauge arc · Health sparkline · DNA bar renderer ·
   Farm heatmap canvas · Video frame health chart ·
   Tello altitude/battery live chart · Report radar chart
═══════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════════
   1. GAUGE ARC (standalone — used on panel.html)
══════════════════════════════════════════════════════════════ */
const GaugeChart = (() => {

  function draw(canvasId, score, opts={}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const W    = opts.width  || canvas.offsetWidth  || 200;
    const H    = opts.height || canvas.offsetHeight || 120;
    canvas.width  = W;
    canvas.height = H;

    const cx   = W / 2;
    const cy   = H - 16;
    const R    = Math.min(W, H * 2) * 0.42;
    const pct  = Math.min(Math.max(score || 0, 0), 100) / 100;
    const start= Math.PI;
    const end  = Math.PI + Math.PI * pct;

    ctx.clearRect(0, 0, W, H);

    // Shadow glow
    ctx.save();
    ctx.shadowColor = _healthColor(score);
    ctx.shadowBlur  = 10;

    // Background track
    ctx.beginPath();
    ctx.arc(cx, cy, R, Math.PI, 2 * Math.PI);
    ctx.strokeStyle = '#e5e0d8';
    ctx.lineWidth   = opts.trackW || 14;
    ctx.stroke();

    // Filled arc
    ctx.beginPath();
    ctx.arc(cx, cy, R, start, end);
    const grad = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
    grad.addColorStop(0,   '#ef4444');
    grad.addColorStop(0.4, '#f97316');
    grad.addColorStop(0.7, '#eab308');
    grad.addColorStop(1,   '#22c55e');
    ctx.strokeStyle = grad;
    ctx.lineWidth   = opts.trackW || 14;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.restore();

    // Tick marks
    if (opts.ticks !== false) {
      for (let i = 0; i <= 10; i++) {
        const angle  = Math.PI + (Math.PI * i / 10);
        const inner  = R - 18;
        const outer  = R - 10;
        ctx.beginPath();
        ctx.moveTo(cx + inner * Math.cos(angle), cy + inner * Math.sin(angle));
        ctx.lineTo(cx + outer * Math.cos(angle), cy + outer * Math.sin(angle));
        ctx.strokeStyle = i % 5 === 0 ? '#a8a29e' : '#d6d3d1';
        ctx.lineWidth   = i % 5 === 0 ? 2 : 1;
        ctx.stroke();
      }
    }

    // Needle
    if (opts.needle !== false) {
      const angle  = Math.PI + Math.PI * pct;
      const nLen   = R - 22;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(nLen, 0);
      ctx.strokeStyle = '#1c1917';
      ctx.lineWidth   = 2;
      ctx.lineCap     = 'round';
      ctx.stroke();
      // Needle base dot
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#1c1917';
      ctx.fill();
      ctx.restore();
    }

    // Centre score text
    if (opts.showScore !== false) {
      ctx.fillStyle = '#1c1917';
      ctx.font      = `bold ${opts.fontSize || 22}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(score || 0), cx, cy - 6);
      ctx.fillStyle = '#a8a29e';
      ctx.font      = `${opts.subFontSize || 11}px Inter, system-ui, sans-serif`;
      ctx.fillText('/100', cx, cy + 10);
    }
  }

  function _healthColor(score) {
    if (score >= 90) return '#22c55e';
    if (score >= 75) return '#4ade80';
    if (score >= 55) return '#eab308';
    if (score >= 35) return '#f97316';
    return '#ef4444';
  }

  function animate(canvasId, targetScore, duration=800) {
    let current = 0;
    const step  = targetScore / (duration / 16);
    const tick  = () => {
      current = Math.min(current + step, targetScore);
      draw(canvasId, current);
      if (current < targetScore) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  return { draw, animate };
})();

/* ══════════════════════════════════════════════════════════════
   2. SPARKLINE — tiny inline health trend
══════════════════════════════════════════════════════════════ */
const Sparkline = (() => {

  function draw(canvasId, data, opts={}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.width  = canvas.offsetWidth  || 120;
    const H   = canvas.height = canvas.offsetHeight || 32;
    ctx.clearRect(0, 0, W, H);

    const min   = opts.min ?? Math.min(...data);
    const max   = opts.max ?? Math.max(...data);
    const range = max - min || 1;
    const pad   = 4;

    const xs = data.map((_,i) => pad + (i / (data.length - 1)) * (W - pad * 2));
    const ys = data.map(v  => H - pad - ((v - min) / range) * (H - pad * 2));

    // Fill
    ctx.beginPath();
    ctx.moveTo(xs[0], H);
    xs.forEach((x,i) => ctx.lineTo(x, ys[i]));
    ctx.lineTo(xs[xs.length-1], H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,   'rgba(245,158,11,.35)');
    grad.addColorStop(1,   'rgba(245,158,11,.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    xs.forEach((x,i) => ctx.lineTo(x, ys[i]));
    ctx.strokeStyle = opts.color || '#f59e0b';
    ctx.lineWidth   = opts.lineW || 1.5;
    ctx.lineJoin    = 'round';
    ctx.stroke();

    // Last point dot
    const lx = xs[xs.length-1];
    const ly = ys[ys.length-1];
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = opts.color || '#f59e0b';
    ctx.fill();
  }

  return { draw };
})();

/* ══════════════════════════════════════════════════════════════
   3. DNA BAR — defect fingerprint renderer
══════════════════════════════════════════════════════════════ */
const DNABar = (() => {
  const CLASS_COLS = {
    soiling:         '#f59e0b',
    physical_damage: '#ef4444',
    bird_dropping:   '#8b5cf6',
    hotspot:         '#f97316',
    shadow:          '#6b7280',
    burn_mark:       '#dc2626',
    delamination:    '#0ea5e9',
    discoloration:   '#ec4899',
    crack:           '#b45309',
  };

  function render(containerId, detections) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;

    if (!detections || !detections.length) {
      wrap.innerHTML =
        '<div class="dna-bar-wrap">' +
        '<div class="dna-segment" style="flex:1;background:#22c55e;border-radius:99px;' +
        'display:flex;align-items:center;justify-content:center;font-size:.65rem;color:#fff;font-weight:700">✅ Clean</div>' +
        '</div>';
      return;
    }

    const total = detections.reduce((s,d) => s + d.confidence, 0);
    wrap.innerHTML =
      '<div class="dna-bar-wrap" style="display:flex;height:28px;border-radius:99px;overflow:hidden;gap:2px">' +
      detections.map(d => {
        const col  = CLASS_COLS[d.class] || '#999';
        const flex = Math.max(1, Math.round(d.confidence / total * 20));
        const label= d.class.replace(/_/g,' ');
        const pct  = (d.confidence * 100).toFixed(0);
        return `<div class="dna-segment" style="flex:${flex};background:${col};cursor:pointer"
                     title="${label} — ${pct}% conf"
                     data-label="${label} ${pct}%"></div>`;
      }).join('') +
      '</div>';
  }

  return { render };
})();

/* ══════════════════════════════════════════════════════════════
   4. FARM HEATMAP CANVAS
══════════════════════════════════════════════════════════════ */
const FarmHeatmap = (() => {

  function draw(canvasId, panels, cols=8) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof panels === 'undefined') return;
    const rows   = Math.ceil(panels.length / cols);
    const CW     = Math.floor(canvas.offsetWidth / cols);
    const CH     = Math.max(28, CW * 0.7);
    canvas.width  = CW * cols;
    canvas.height = CH * rows;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    panels.forEach((p, i) => {
      const col  = i % cols;
      const row  = Math.floor(i / cols);
      const x    = col * CW;
      const y    = row * CH;
      const h    = p.health_score ?? 100;
      ctx.fillStyle   = _heatColor(h);
      ctx.fillRect(x+1, y+1, CW-2, CH-2);
      // label
      ctx.fillStyle   = h < 50 ? '#fff' : '#1c1917';
      ctx.font        = `bold ${Math.max(8, CW * 0.22)}px Inter, sans-serif`;
      ctx.textAlign   = 'center';
      ctx.textBaseline= 'middle';
      ctx.fillText(p.panel_id || ('P'+(i+1)), x + CW/2, y + CH/2);
    });
  }

  function _heatColor(h) {
    if (h >= 90) return '#bbf7d0';
    if (h >= 75) return '#d1fae5';
    if (h >= 55) return '#fef9c3';
    if (h >= 35) return '#ffedd5';
    return '#fee2e2';
  }

  return { draw };
})();

/* ══════════════════════════════════════════════════════════════
   5. VIDEO FRAME HEALTH CHART (Chart.js line)
══════════════════════════════════════════════════════════════ */
const VideoFrameChart = (() => {
  let _chart = null;

  function render(canvasId, frames) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    if (_chart) { _chart.destroy(); _chart = null; }

    const labels = frames.map(f => 'F' + f.frame);
    const data   = frames.map(f => f.health);
    const colors = frames.map(f =>
      f.health < 35 ? '#ef4444' :
      f.health < 55 ? '#f97316' :
      f.health < 75 ? '#eab308' : '#22c55e'
    );

    _chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Frame Health %',
          data,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,.1)',
          borderWidth: 2,
          pointBackgroundColor: colors,
          pointRadius: 5,
          tension: 0.3,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { min:0, max:100, grid:{ color:'#e5e0d8' }, ticks:{ callback:v=>v+'/100' } },
          x: { grid:{ display:false } },
        },
      },
    });
  }

  return { render };
})();

/* ══════════════════════════════════════════════════════════════
   6. TELLO LIVE CHART — altitude + battery rolling window
══════════════════════════════════════════════════════════════ */
const TelloLiveChart = (() => {
  let _chart = null;
  const MAX_POINTS = 60;
  const _alt  = [];
  const _batt = [];
  const _labels = [];

  function init(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    if (_chart) { _chart.destroy(); _chart = null; }

    _chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: _labels,
        datasets: [
          {
            label: 'Altitude (cm)',
            data: _alt,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,.1)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.4,
            fill: true,
            yAxisID: 'yAlt',
          },
          {
            label: 'Battery %',
            data: _batt,
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,.08)',
            borderWidth: 1.5,
            pointRadius: 0,
            borderDash: [4,3],
            tension: 0.4,
            fill: false,
            yAxisID: 'yBatt',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: true, position: 'top',
            labels: { font:{ size:10 }, boxWidth:10 } },
        },
        scales: {
          yAlt: {
            beginAtZero: true,
            grid: { color: '#e5e0d8' },
            ticks: { callback: v => v+'cm' },
            title: { display:true, text:'Altitude' },
          },
          yBatt: {
            position: 'right',
            min: 0, max: 100,
            grid: { display: false },
            ticks: { callback: v => v+'%' },
            title: { display:true, text:'Battery' },
          },
          x: { grid:{ display:false }, ticks:{ maxTicksLimit:8 } },
        },
      },
    });
  }

  function push(altitude, battery) {
    if (!_chart) return;
    const now = new Date().toTimeString().slice(3,8);
    _labels.push(now);
    _alt.push(altitude);
    _batt.push(battery);
    if (_labels.length > MAX_POINTS) {
      _labels.shift(); _alt.shift(); _batt.shift();
    }
    _chart.update('none');
  }

  function reset() {
    _labels.length = 0; _alt.length = 0; _batt.length = 0;
    if (_chart) _chart.update();
  }

  return { init, push, reset };
})();

/* ══════════════════════════════════════════════════════════════
   7. REPORT RADAR — multi-metric panel quality radar
══════════════════════════════════════════════════════════════ */
const ReportRadar = (() => {
  let _chart = null;

  function render(canvasId, result) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined' || !result) return;
    if (_chart) { _chart.destroy(); _chart = null; }

    const health  = result.health_score  || 0;
    const conf    = result.stage1?.conf_avg ? result.stage1.conf_avg * 100 : 80;
    const soiling = Math.max(0, 100 - (result.soiling_pct || 0));
    const energy  = Math.max(0, 100 - Math.min(100, (result.energy_loss || 0) / 4));
    const defFree = Math.max(0, 100 - (result.total_defects || 0) * 15);
    const roi     = Math.min(100, energy * 0.9);

    _chart = new Chart(canvas.getContext('2d'), {
      type: 'radar',
      data: {
        labels: ['Health','Confidence','Cleanliness','Energy Eff.','Defect-Free','ROI Score'],
        datasets: [{
          label: result.panel_id || 'Panel',
          data: [health, conf, soiling, energy, defFree, roi],
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,.15)',
          borderWidth: 2,
          pointBackgroundColor: '#f59e0b',
          pointRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            grid:      { color: '#e5e0d8' },
            angleLines:{ color: '#e5e0d8' },
            pointLabels:{ font:{ size:10, weight:'600' }, color:'#78716c' },
            ticks: { display: false, stepSize: 20 },
          },
        },
      },
    });
  }

  return { render };
})();

/* ══════════════════════════════════════════════════════════════
   8. MINI DONUT — reusable single-value donut (KPI cards)
══════════════════════════════════════════════════════════════ */
const MiniDonut = (() => {
  const _charts = {};

  function draw(canvasId, value, total, color='#f59e0b') {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    if (_charts[canvasId]) { _charts[canvasId].destroy(); }

    _charts[canvasId] = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [value, Math.max(0, total - value)],
          backgroundColor: [color + 'dd', '#e5e0d8'],
          borderWidth: 0,
          hoverOffset: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '70%',
        plugins: { legend:{ display:false }, tooltip:{ enabled:false } },
        animation: { duration: 600, easing: 'easeInOutQuart' },
      },
    });
  }

  return { draw };
})();

/* ══════════════════════════════════════════════════════════════
   9. AUTO-INIT sparklines on page load
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Draw gauge on panel detail page if exists
  const gCanvas = document.getElementById('gaugeCanvasLarge');
  if (gCanvas) {
    const score = parseFloat(gCanvas.dataset.score || 0);
    GaugeChart.animate('gaugeCanvasLarge', score);
  }

  // Intel bar sparkline
  const sparkEl = document.getElementById('intelSparkline');
  if (sparkEl) {
    const all = typeof Session !== 'undefined' ? Session.getAll() : [];
    if (all.length) Sparkline.draw('intelSparkline', all.map(r=>r.health_score||0).reverse());
  }
});

/* ══════════════════════════════════════════════════════════════
   EXPOSE GLOBALS
══════════════════════════════════════════════════════════════ */
window.GaugeChart      = GaugeChart;
window.Sparkline       = Sparkline;
window.DNABar          = DNABar;
window.FarmHeatmap     = FarmHeatmap;
window.VideoFrameChart = VideoFrameChart;
window.TelloLiveChart  = TelloLiveChart;
window.ReportRadar     = ReportRadar;
window.MiniDonut       = MiniDonut;
