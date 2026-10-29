/* ═══════════════════════════════════════════════════════════════
   SOLARVISION — pdf-export.js
   PDF generation via jsPDF + html2canvas
   Exports the report page as a styled A4 PDF
═══════════════════════════════════════════════════════════════ */

'use strict';

const PDFExport = (() => {

  /* ── Entry point called from Report page button ── */
  async function exportReport(result) {
    result = result || (typeof Session !== 'undefined' ? Session.getLatest() : null);
    if (!result) { Toast.warn('No report to export — run an inspection first'); return; }

    // Check jsPDF available
    if (typeof window.jspdf === 'undefined' && typeof jsPDF === 'undefined') {
      Toast.warn('PDF library not loaded — using browser print instead');
      window.print();
      return;
    }

    Toast.info('Generating PDF…');

    try {
      const { jsPDF } = window.jspdf || window;
      const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
      const W   = doc.internal.pageSize.getWidth();
      const H   = doc.internal.pageSize.getHeight();
      const margin = 14;
      let y = margin;

      /* ── Cover header ── */
      doc.setFillColor(28, 25, 23);   // --dark
      doc.rect(0, 0, W, 32, 'F');

      // Logo text
      doc.setTextColor(245, 158, 11);  // amber
      doc.setFont('helvetica','bold');
      doc.setFontSize(16);
      doc.text('⚡ SolarVision', margin, 14);

      doc.setTextColor(214, 211, 209);
      doc.setFont('helvetica','normal');
      doc.setFontSize(9);
      doc.text('Solar Panel Inspection Report', margin, 21);
      doc.text('Generated: ' + new Date().toLocaleString('en-AU'), margin, 27);

      // Mode badge
      const mode = (typeof SS !== 'undefined' && SS.session.simMode) ? 'SIM MODE' : 'LIVE';
      doc.setFillColor(245, 158, 11);
      doc.roundedRect(W - margin - 24, 10, 24, 8, 2, 2, 'F');
      doc.setTextColor(28,25,23);
      doc.setFont('helvetica','bold');
      doc.setFontSize(7);
      doc.text(mode, W - margin - 12, 15, { align:'center' });

      y = 42;

      /* ── Meta row ── */
      const meta = [
        ['Panel ID',  result.panel_id   || '—'],
        ['Date',      result.date        || new Date().toLocaleDateString('en-AU')],
        ['Model',     (result.model||'—').toUpperCase()],
        ['Location',  result.location   || '—'],
        ['Health',    (result.health_score != null ? Math.round(result.health_score) : '—') + '/100'],
        ['Label',     result.health_label || '—'],
      ];
      const colW = (W - margin*2) / meta.length;
      meta.forEach(([label, val], i) => {
        const x = margin + i * colW;
        doc.setFillColor(248, 246, 241);
        doc.rect(x, y, colW - 2, 16, 'F');
        doc.setTextColor(120,113,108);
        doc.setFont('helvetica','normal');
        doc.setFontSize(7);
        doc.text(label.toUpperCase(), x + 3, y + 5);
        doc.setTextColor(28,25,23);
        doc.setFont('helvetica','bold');
        doc.setFontSize(9);
        doc.text(String(val), x + 3, y + 12);
      });

      y += 22;

      /* ── Health bar ── */
      const score = result.health_score || 0;
      _healthBar(doc, margin, y, W - margin*2, score);
      y += 14;

      /* ── Section: NLP Report ── */
      y = _sectionHeader(doc, 'AI Inspection Report', y, W, margin);
      doc.setTextColor(68,64,60);
      doc.setFont('helvetica','normal');
      doc.setFontSize(9);
      const nlpLines = doc.splitTextToSize(result.nlp_report || '—', W - margin*2);
      doc.text(nlpLines, margin, y);
      y += nlpLines.length * 4.5 + 6;

      /* ── Section: ROI ── */
      if (y > H - 60) { doc.addPage(); y = margin; }
      y = _sectionHeader(doc, 'ROI & Energy Analysis', y, W, margin);

      const pricePerKwh = (typeof SS !== 'undefined') ? SS.conf.pricePerKwh : 0.28;
      const cleanCost   = (typeof SS !== 'undefined') ? SS.conf.cleanCost   : 45;
      const energyLoss  = result.energy_loss || 0;
      const annualLoss  = (energyLoss/1000) * pricePerKwh * 365;
      const payback     = energyLoss > 0
        ? Math.ceil(cleanCost / ((energyLoss/1000) * pricePerKwh)) + ' days'
        : '—';

      const roi = [
        ['Energy Loss',  (energyLoss.toFixed(1)) + ' Wh'],
        ['Annual Loss',  '$' + annualLoss.toFixed(2)],
        ['Clean Cost',   '$' + cleanCost.toFixed(2)],
        ['Payback',      payback],
        ['Clean Date',   result.clean_date || '—'],
        ['Soiling',      (result.soiling_pct || 0).toFixed(1) + '%'],
      ];
      const rColW = (W - margin*2) / roi.length;
      roi.forEach(([label, val], i) => {
        const x = margin + i * rColW;
        doc.setFillColor(248, 246, 241);
        doc.rect(x, y, rColW - 2, 14, 'F');
        doc.setTextColor(120,113,108);
        doc.setFont('helvetica','normal');
        doc.setFontSize(6.5);
        doc.text(label.toUpperCase(), x+3, y+5);
        doc.setTextColor(28,25,23);
        doc.setFont('helvetica','bold');
        doc.setFontSize(8.5);
        doc.text(String(val), x+3, y+11);
      });
      y += 20;

      /* ── Section: Detections table ── */
      if (y > H - 60) { doc.addPage(); y = margin; }
      const dets = result.detections || [];
      y = _sectionHeader(doc, `Detections (${dets.length})`, y, W, margin);

      if (dets.length) {
        // Table header
        const tCols = ['#','Class','Confidence','Priority'];
        const tWidths = [8, 60, 40, 36];
        let tx = margin;
        doc.setFillColor(28,25,23);
        doc.rect(margin, y, W-margin*2, 7, 'F');
        doc.setTextColor(255,255,255);
        doc.setFont('helvetica','bold');
        doc.setFontSize(8);
        tCols.forEach((h,i) => {
          doc.text(h, tx+2, y+5);
          tx += tWidths[i];
        });
        y += 7;

        const PRIORITY_RGB = {
          Critical:[239,68,68], High:[249,115,22],
          Medium:[234,179,8],   Low:[34,197,94],
        };
        dets.forEach((d,idx) => {
          if (y > H - 20) { doc.addPage(); y = margin; }
          doc.setFillColor(idx%2===0 ? 248 : 255, idx%2===0 ? 246 : 255, idx%2===0 ? 241 : 255);
          doc.rect(margin, y, W-margin*2, 6.5, 'F');
          doc.setTextColor(28,25,23);
          doc.setFont('helvetica','normal');
          doc.setFontSize(8);
          tx = margin;
          [String(idx+1), d.class.replace(/_/g,' '), (d.confidence*100).toFixed(1)+'%', ''].forEach((v,i) => {
            doc.text(v, tx+2, y+4.5);
            tx += tWidths[i];
          });
          // Priority badge
          const rgb = PRIORITY_RGB[d.priority] || [120,113,108];
          doc.setFillColor(...rgb);
          doc.roundedRect(tx - tWidths[3] + margin - 6, y+0.5, 28, 5.5, 1.5, 1.5, 'F');
          doc.setTextColor(255,255,255);
          doc.setFont('helvetica','bold');
          doc.setFontSize(7);
          doc.text(d.priority, tx - tWidths[3] + margin + 8, y+4.5);
          y += 6.5;
        });
      } else {
        doc.setTextColor(120,113,108);
        doc.setFont('helvetica','italic');
        doc.setFontSize(9);
        doc.text('No defects detected ✅', margin, y+6);
        y += 12;
      }

      /* ── Footer on every page ── */
      const totalPages = doc.internal.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFillColor(248, 246, 241);
        doc.rect(0, H-10, W, 10, 'F');
        doc.setTextColor(120,113,108);
        doc.setFont('helvetica','normal');
        doc.setFontSize(7);
        doc.text('SolarVision — Confidential Inspection Report', margin, H-4);
        doc.text(`Page ${p} of ${totalPages}`, W-margin, H-4, { align:'right' });
      }

      /* ── Save ── */
      const fname = `SunSight_${result.panel_id}_${result.date || 'report'}.pdf`
        .replace(/[^a-zA-Z0-9_.-]/g,'_');
      doc.save(fname);
      Toast.success('PDF saved: ' + fname);

    } catch(err) {
      console.error('PDF export error:', err);
      Toast.error('PDF export failed — using browser print');
      window.print();
    }
  }

  /* ── Health bar helper ── */
  function _healthBar(doc, x, y, width, score) {
    const pct = Math.min(Math.max(score, 0), 100) / 100;
    // Background
    doc.setFillColor(229, 224, 216);
    doc.roundedRect(x, y, width, 5, 2, 2, 'F');
    // Fill
    const rgb = score >= 75 ? [34,197,94] : score >= 55 ? [234,179,8] : score >= 35 ? [249,115,22] : [239,68,68];
    doc.setFillColor(...rgb);
    doc.roundedRect(x, y, Math.max(4, width * pct), 5, 2, 2, 'F');
    // Score label
    doc.setTextColor(28,25,23);
    doc.setFont('helvetica','bold');
    doc.setFontSize(8);
    doc.text(Math.round(score)+'/100', x + width + 3, y + 4);
  }

  /* ── Section header helper ── */
  function _sectionHeader(doc, title, y, W, margin) {
    doc.setFillColor(245, 158, 11);
    doc.rect(margin, y, 3, 8, 'F');
    doc.setTextColor(28, 25, 23);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(title, margin + 6, y + 6);
    doc.setDrawColor(229, 224, 216);
    doc.line(margin + 6, y + 9, W - margin, y + 9);
    return y + 14;
  }

  return { exportReport };
})();

window.PDFExport = PDFExport;
