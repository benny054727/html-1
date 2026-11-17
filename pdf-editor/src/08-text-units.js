/* ---------- Letters, words and lines ----------
   PDFs store text in pieces of any size: a whole line, one word, or a single letter.
   The pieces are cut into letters (positions estimated from letter widths) and joined back into
   words and lines by the gaps between them, so a tap selects exactly the unit the user chose. */
const unitBox = (u) => ({ x1: u.x1 - u.h * 0.03, y1: u.y - u.h * 0.28, x2: u.x2 + u.h * 0.03, y2: u.y + u.h * 0.95, h: u.h });
function letterPieces() {
  const out = [];
  for (const it of ed.items) {
    const h = itemBox(it).h, s = it.str, y = it.transform[5], x0 = it.transform[4];
    measureCtx.font = `400 ${h}px Arimo, Arial, sans-serif`;
    const chars = [...s];
    const w = chars.map(ch => measureCtx.measureText(ch).width || h * 0.3);
    const k = it.width / (w.reduce((a, b) => a + b, 0) || 1);
    const rtlItem = isHebrew(s) || it.dir === 'rtl';
    // split into words (runs without spaces) in logical order, with their offset from the start edge
    let pos = 0, word = null;
    const words = [];
    chars.forEach((ch, n) => {
      if (/\s/.test(ch)) { word = null; pos += w[n]; return; }
      if (!word) { word = { start: pos, chars: [] }; words.push(word); }
      word.chars.push({ ch, w: w[n] }); pos += w[n];
    });
    for (const wd of words) {
      const ww = wd.chars.reduce((a, c) => a + c.w, 0);
      const left = rtlItem ? x0 + it.width - (wd.start + ww) * k : x0 + wd.start * k;
      const ltrWord = !wd.chars.some(c => isHebrew(c.ch));        // numbers and English read left to right
      let cur = ltrWord ? left : left + ww * k;
      for (const c of wd.chars) {
        const cw = c.w * k;
        const x1 = ltrWord ? cur : cur - cw;
        out.push({ ch: c.ch, x1, x2: x1 + cw, y, h, item: it.i });
        cur = ltrWord ? cur + cw : cur - cw;
      }
    }
  }
  return out;
}
/* Join letters that sit on one baseline into runs; a gap wider than maxGap starts a new run */
function joinPieces(pieces, maxGap) {
  const lines = [];
  for (const pc of [...pieces].sort((a, b) => b.y - a.y || a.x1 - b.x1)) {
    let line = lines.find(l => Math.abs(l.y - pc.y) < Math.min(l.h, pc.h) * 0.35 && Math.abs(l.h - pc.h) < Math.max(l.h, pc.h) * 0.45);
    if (!line) { line = { y: pc.y, h: pc.h, list: [] }; lines.push(line); }
    line.list.push(pc);
  }
  const units = [];
  for (const line of lines) {
    const list = line.list.sort((a, b) => a.x1 - b.x1);
    let run = [list[0]];
    const flush = () => units.push(makeUnit(run));
    for (let n = 1; n < list.length; n++) {
      if (list[n].x1 - list[n - 1].x2 > maxGap(line.h)) { flush(); run = []; }
      run.push(list[n]);
    }
    flush();
  }
  return units;
}
function makeUnit(run) {
  const h = Math.max(...run.map(r => r.h)), y = run[0].y;
  const rtl = run.some(r => isHebrew(r.ch)) || ed.items.some(x => Math.abs(x.transform[5] - y) < h * 0.3 && isHebrew(x.str));
  // reading order: right to left in Hebrew, but numbers and English keep their own order
  const groups = [];
  for (const r of [...run].sort((a, b) => a.x1 - b.x1)) {
    const ltr = !isHebrew(r.ch) && !/[\s"'.,:;!?()\-–]/.test(r.ch);
    const g = groups[groups.length - 1];
    const gap = g ? r.x1 - g.x2 : 0;
    if (g && g.ltr === ltr && gap < h * 0.12) { g.items.push(r); g.x2 = r.x2; }
    else groups.push({ ltr, items: [r], x1: r.x1, x2: r.x2, gapBefore: gap });
  }
  const seq = rtl ? [...groups].reverse() : groups;
  let text = '';
  seq.forEach((g, n) => {
    const neighbour = rtl ? seq[n - 1] : null;
    const gapBefore = rtl ? (neighbour ? neighbour.x1 - g.x2 : 0) : g.gapBefore;
    if (n && gapBefore > h * 0.12) text += ' ';
    const chars = (g.ltr || !rtl) ? g.items : [...g.items].reverse();
    text += chars.map(c => c.ch).join('');
  });
  return { text, x1: Math.min(...run.map(r => r.x1)), x2: Math.max(...run.map(r => r.x2)), y, h, rtl, items: [...new Set(run.map(r => r.item))] };
}
function getUnits() {
  const mode = prefs.unit;
  if (ed.units && ed.units.mode === mode) return ed.units.list;
  const letters = letterPieces();
  let list;
  if (mode === 'letter') list = letters.map(l => makeUnit([l]));
  else list = joinPieces(letters, mode === 'line' ? (h) => h * 1.6 : (h) => h * 0.12);
  list.forEach((u, n) => { u.id = n; });
  ed.units = { mode, list };
  return list;
}
function replaceUnit(p, u) {
  snapshot();
  const box = unitBox(u);
  const v = toView(box);
  const bg = sampleBg(v);
  const rect = { id: uid++, x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, color: bg, link: true };
  p.rects = p.rects || [];
  p.rects.push(rect);
  const first = ed.items.find(x => x.i === u.items[0]);
  const g = first ? guessFont(first) : { font: 'arimo', bold: false };
  const o = {
    id: uid++, text: u.text, size: Math.round(u.h * 10) / 10, color: textColorInside(v, bg), bold: g.bold, font: g.font,
    // anchored at the start edge of the original text (right edge in Hebrew), on its baseline
    px: u.rtl ? u.x2 : u.x1, py: u.y, srcY: u.y, vb: 'base', ang: 0, anchor: u.rtl ? 'r' : 'l',
    srcItem: u.items[0], srcItems: u.items, rectId: rect.id,
  };
  p.overlays.push(o);
  ed.selId = o.id; ed.selRect = null;
  loadFields(o);
  startInline(o, true);
}
/* Keep text on a line: replaced text stays on its own baseline, other text snaps to nearby lines */
function snapToLine(o) {
  hideGuide();
  if (!prefs.lock || ((o.ang % 360) + 360) % 360 !== 0 || (o.rot || 0) !== 0 || o.vb !== 'base') return;
  let y = null;
  if (o.srcY != null) y = o.srcY;
  else if (o.srcItem != null) {
    const it = ed.items.find(x => x.i === o.srcItem);
    if (it) y = it.transform[5];
  } else {
    let bd = 7 / ed.scale;
    for (const it of ed.items) { const d = Math.abs(it.transform[5] - o.py); if (d < bd) { bd = d; y = it.transform[5]; } }
  }
  if (y == null) return;
  o.py = y;
  showGuide(o);
}
function showGuide(o) {
  let g = $('stage').querySelector('.guide');
  if (!g) { g = document.createElement('div'); g.className = 'guide'; $('stage').appendChild(g); }
  const [x, y] = ed.vp.convertToViewportPoint(o.px, o.py);
  const vertical = ed.R % 180 !== 0;
  g.classList.toggle('v', vertical);
  g.style.left = vertical ? x + 'px' : '0'; g.style.top = vertical ? '0' : y + 'px';
}
function hideGuide() { $('stage').querySelector('.guide')?.remove(); }

const pointers = new Map();
function cancelGestures() {
  if (ed.draw) { ed.draw.el.remove(); ed.draw = null; }
  ed.drag = null; ed.tap = null;
}
function startPinch() {
  cancelGestures();
  const [a, b] = [...pointers.values()];
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const r = $('stage').getBoundingClientRect();
  ed.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: ed.zoom, fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height };
}
function startTap(e, kind, extra) {
  const body = $('edBody');
  ed.tap = { kind, x0: e.clientX, y0: e.clientY, sl: body.scrollLeft, st: body.scrollTop, pan: false, ...extra };
}
$('stage').addEventListener('pointerdown', (e) => {
  const p = edPage(); if (!p || !ed.vp) return;
  if (e.target.closest('.ff') || e.target.closest('.ov-edit')) return;   // typing in a form field or in text on the page
  if (ed.inline) {                                // a tap anywhere else only ends typing
    finishInline();
    if (!e.target.closest('.ov, .obj, .ti')) { ed.selId = null; drawOverlays(); startTap(e, 'none'); return; }
  }
  if (e.button > 0) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { $('stage').setPointerCapture(e.pointerId); } catch (_) {}
  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;
  const rsEl = e.target.closest('.rs');
  const objEl = e.target.closest('.obj');
  if (objEl && ed.mode !== 'shape') {
    const o = (p.objs || []).find(x => x.id === +objEl.dataset.id);
    if (o) {
      selectObj(o.id);
      const [cx, cy] = ed.vp.convertToViewportPoint(o.cx, o.cy);
      const [mx, my] = stagePoint(e);
      ed.odrag = rsEl ? { o, resize: true, cx, cy, w0: o.w, h0: o.h, d0x: Math.abs(mx - cx), d0y: Math.abs(my - cy), moved: false }
                      : { o, dx: mx - cx, dy: my - cy, moved: false };
      return;
    }
  }
  const xb = e.target.closest('.x');
  if (xb) {
    snapshot();
    const host = xb.parentElement;
    if (host.classList.contains('ov')) removeOverlay(p, +host.dataset.id);
    else p.rects = (p.rects || []).filter(r => r.id !== +host.dataset.id);
    ed.selId = null; ed.selRect = null; drawOverlays(); return;
  }
  const ovEl = e.target.closest('.ov');
  if (ovEl) {
    const o = p.overlays.find(x => x.id === +ovEl.dataset.id);
    const wasSel = ed.selId === o.id;
    ed.selId = o.id; ed.selRect = null; ed.selObj = null;
    loadFields(o);
    const [x, y] = ed.vp.convertToViewportPoint(o.px, o.py);
    const [mx, my] = stagePoint(e);
    ed.drag = { o, dx: mx - x, dy: my - y, moved: false, wasSel };
    drawOverlays();
    return;
  }
  const erEl = e.target.closest('.er');
  if (erEl && !e.target.closest('.ti')) {
    const r = (p.rects || []).find(x => x.id === +erEl.dataset.id);
    if (r && !r.link) { ed.selRect = r.id; ed.selId = null; drawOverlays(); return; }
  }
  const tiEl = e.target.closest('.ti');
  if (tiEl && ed.mode === 'edit') { startTap(e, 'ti', { i: +tiEl.dataset.i }); return; }
  if (tiEl && ed.mode === 'mark') { startTap(e, 'mk', { i: +tiEl.dataset.i }); return; }
  if (ed.selId || ed.selRect || ed.selObj) {
    releaseField(edSel());
    ed.selId = null; ed.selRect = null; ed.selObj = null; drawOverlays();
    if (!['erase', 'shape', 'mark'].includes(ed.mode)) { startTap(e, 'none'); return; }
  }
  if (ed.mode === 'erase' || ed.mode === 'shape' || ed.mode === 'mark') {
    const [x, y] = stagePoint(e);
    const el = document.createElement('div');
    el.className = 'er drawing' + (ed.mode === 'shape' ? ' shape' : ed.mode === 'mark' ? ' mark' : prefs.erase === 'redact' ? ' redact-draw' : '');
    $('stage').appendChild(el);
    ed.draw = { x0: x, y0: y, el, x, y };
    return;
  }
  // Text and edit modes: a tap acts, a drag scrolls the page
  startTap(e, ed.mode === 'text' ? 'add' : 'none');
});
$('stage').addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ed.pinch) {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    zoomAt(ed.pinch.z0 * d / ed.pinch.d0, ed.pinch.fx, ed.pinch.fy, (a.x + b.x) / 2, (a.y + b.y) / 2);
    return;
  }
  if (ed.tap) {
    const t = ed.tap, dx = e.clientX - t.x0, dy = e.clientY - t.y0;
    if (!t.pan && Math.hypot(dx, dy) > 8) t.pan = true;
    if (t.pan) { const body = $('edBody'); body.scrollLeft = t.sl - dx; body.scrollTop = t.st - dy; }
    return;
  }
  if (ed.odrag) { moveObj(e); return; }
  if (ed.draw) {
    const [x, y] = stagePoint(e);
    Object.assign(ed.draw, { x, y });
    const d = ed.draw;
    Object.assign(d.el.style, { left: Math.min(d.x0, x) + 'px', top: Math.min(d.y0, y) + 'px', width: Math.abs(x - d.x0) + 'px', height: Math.abs(y - d.y0) + 'px' });
    return;
  }
  if (!ed.drag) return;
  if (!ed.drag.moved) { snapshot(); ed.drag.moved = true; }
  const [mx, my] = stagePoint(e);
  [ed.drag.o.px, ed.drag.o.py] = ed.vp.convertToPdfPoint(mx - ed.drag.dx, my - ed.drag.dy);
  snapToLine(ed.drag.o);
  const el = $('stage').querySelector(`.ov[data-id="${ed.drag.o.id}"]`);
  if (el) positionOv(el, ed.drag.o);
  positionFmtBar();
});
function doTap(t, e) {
  const p = edPage(); if (!p) return;
  if (t.kind === 'ti') {
    const u = getUnits().find(x => x.id === t.i);
    if (u) replaceUnit(p, u);
    return;
  }
  if (t.kind === 'mk') {
    const u = getUnits().find(x => x.id === t.i);
    if (u) { const v = toView(unitBox(u)); addShapeFromView('mark', v.left, v.top, v.left + v.width, v.top + v.height); }
    return;
  }
  if (t.kind !== 'add') return;
  const text = $('edText').value.trim() ? $('edText').value : '';
  snapshot();
  const [x, y] = stagePoint(e);
  const [px, py] = ed.vp.convertToPdfPoint(x, y);
  const o = { id: uid++, text, ...styleCopy(defStyle), px, py, ang: ed.R, vb: 'base' };
  // the tap marks the middle of the text; move the anchor down to its first baseline
  const img = ovImg(o), d = img.asc - img.h / 2, th = o.ang * Math.PI / 180;
  o.px += d * Math.sin(th); o.py -= d * Math.cos(th);
  snapToLine(o); hideGuide();
  p.overlays.push(o);
  ed.selId = o.id;
  if (!text) { o.fresh = true; startInline(o); return; }
  drawOverlays();
}
function endPointer(e) {
  pointers.delete(e.pointerId);
  hideGuide();
  if (ed.pinch) { if (pointers.size < 2) ed.pinch = null; return; }
  if (ed.tap) {
    const t = ed.tap; ed.tap = null;
    if (!t.pan && e.type === 'pointerup') doTap(t, e);
    return;
  }
  const dr = ed.drag; ed.drag = null;
  if (dr && !dr.moved && dr.wasSel && e.type === 'pointerup') { startInline(dr.o); return; }
  if (ed.odrag) { endObjDrag(); return; }
  const d = ed.draw; if (!d) return;
  ed.draw = null;
  d.el.remove();
  if (e.type !== 'pointerup') return;
  const w = Math.abs(d.x - d.x0), h = Math.abs(d.y - d.y0);
  if (ed.mode === 'shape' || ed.mode === 'mark') {
    const isLine = ed.mode === 'shape' && (ed.shape === 'line' || ed.shape === 'arrow');
    if (isLine ? Math.hypot(w, h) < 8 : (w < 4 || h < 4)) return;
    addShapeFromView(ed.mode === 'mark' ? 'mark' : ed.shape, d.x0, d.y0, d.x, d.y);
    return;
  }
  if (w < 4 || h < 4) return;
  const p = edPage();
  const v = { left: Math.min(d.x0, d.x), top: Math.min(d.y0, d.y), width: w, height: h };
  const [ax, ay] = ed.vp.convertToPdfPoint(v.left, v.top);
  const [bx, by] = ed.vp.convertToPdfPoint(v.left + w, v.top + h);
  snapshot();
  p.rects = p.rects || [];
  const redact = prefs.erase === 'redact';
  const r = { id: uid++, x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by), color: redact ? '#000000' : sampleBg(v), redact };
  p.rects.push(r);
  ed.selRect = r.id;
  drawOverlays();
}
$('stage').addEventListener('pointerup', endPointer);
$('stage').addEventListener('pointercancel', endPointer);

