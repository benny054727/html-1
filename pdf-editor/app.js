(() => {
'use strict';
const $ = (id) => document.getElementById(id);
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const { PDFDocument, degrees, rgb, StandardFonts } = PDFLib;

const SRC_COLORS = ['#0f6c72', '#c2410c', '#7c3aed', '#15803d', '#be185d', '#1d4ed8', '#a16207'];
const MAX_FILE_BYTES = 200 * 1024 * 1024;
function looksLikePdf(bytes) {
  // A PDF starts with "%PDF-" within its first 1024 bytes
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}
const UI_FONT = 'Heebo, "Segoe UI", Arial, sans-serif';

/* ---------- State ---------- */
const state = {
  sources: [],   // {name, bytes, pdf, cache: Map}
  pages: [],     // {id, src, idx, rot, overlays:[{id,text,size,color,bold,px,py,ang}]}
  selected: new Set(),
};
let uid = 1;
const history = [];
const thumbCache = new Map(); // page id -> {key, canvas}

function snapshot() {
  history.push(JSON.stringify(state.pages));
  if (history.length > 60) history.shift();
  $('undoBtn').disabled = false;
}
function undo() {
  if (!history.length) return;
  state.pages = JSON.parse(history.pop());
  const ids = new Set(state.pages.map(p => p.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  $('undoBtn').disabled = !history.length;
  renderGrid();
  if ($('editor').open) { if (!edPage()) $('editor').close(); else { ed.selId = null; drawEditor(); } }
  toast('הפעולה בוטלה');
}

/* ---------- Settings ---------- */
function settings() {
  return {
    wm: { on: $('wmOn').checked, text: $('wmText').value, size: +$('wmSize').value || 72, color: $('wmColor').value,
          opacity: +$('wmOpacity').value / 100, angle: +$('wmAngle').value },
    pn: { on: $('pnOn').checked, fmt: $('pnFmt').value, pos: $('pnPos').value, size: +$('pnSize').value || 11,
          start: Number.isFinite(+$('pnStart').value) ? +$('pnStart').value : 1 },
  };
}

/* ---------- Helpers ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}
function busy(on, text) { $('busy').hidden = !on; if (text) $('busyText').textContent = text; }
const isHebrew = (s) => /[֐-׿]/.test(s);

async function getPage(src, idx) {
  const s = state.sources[src];
  if (!s.cache.has(idx)) s.cache.set(idx, s.pdf.getPage(idx + 1));
  return s.cache.get(idx);
}
const totalRot = (pg, p) => ((pg.rotate + p.rot) % 360 + 360) % 360;

function paperName(wPt, hPt) {
  const mm = (v) => Math.round(v / 72 * 25.4);
  const a = Math.min(mm(wPt), mm(hPt)), b = Math.max(mm(wPt), mm(hPt));
  const known = [['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['Letter', 216, 279], ['Legal', 216, 356]];
  const k = known.find(([, x, y]) => Math.abs(a - x) <= 2 && Math.abs(b - y) <= 2);
  return (k ? k[0] + ' · ' : '') + `${mm(wPt)}×${mm(hPt)} מ״מ`;
}

/* Text rendered to an image so that Hebrew (and any script) works in the output PDF */
const textImgCache = new Map();
const measureCtx = document.createElement('canvas').getContext('2d');
function textImage(text, size, color, bold) {
  const key = [text, size, color, bold].join('\u0001');
  if (textImgCache.has(key)) return textImgCache.get(key);
  const font = `${bold ? 700 : 400} ${size}px ${UI_FONT}`;
  measureCtx.font = font;
  const w = Math.max(1, measureCtx.measureText(text).width) + size * 0.2;
  const h = size * 1.35;
  const K = Math.max(0.5, Math.min(5, 4000 / w, 4000 / h));
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * K); c.height = Math.ceil(h * K);
  const ctx = c.getContext('2d');
  ctx.scale(K, K);
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.direction = isHebrew(text) ? 'rtl' : 'ltr';
  ctx.fillText(text, w / 2, h / 2);
  const out = { canvas: c, w, h, key };
  textImgCache.set(key, out);
  if (textImgCache.size > 300) textImgCache.delete(textImgCache.keys().next().value);
  return out;
}

function pageNumberText(fmt, n, t) {
  if (fmt === 'n/t') return `${n} / ${t}`;
  if (fmt === 'he') return `עמוד ${n} מתוך ${t}`;
  if (fmt === 'dash') return `– ${n} –`;
  return String(n);
}

/* Where an overlay's centre sits on the display. Replaced text is anchored at its start edge. */
function overlayCenter(o, vp, R) {
  const [x, y] = vp.convertToViewportPoint(o.px, o.py);
  if (!o.anchor || o.anchor === 'c') return [x, y];
  const img = textImage(o.text || ' ', o.size, o.color, o.bold);
  const a = (o.ang - R) * Math.PI / 180;
  const half = (img.w / 2 - o.size * 0.1) * vp.scale * (o.anchor === 'l' ? 1 : -1);
  return [x + half * Math.cos(a), y - half * Math.sin(a)];
}
/* Areas covered with a solid colour (erased) */
function drawRects(ctx, p, vp) {
  for (const r of p.rects || []) {
    const [a, b, c, d] = vp.convertToViewportRectangle([r.x1, r.y1, r.x2, r.y2]);
    ctx.fillStyle = r.color;
    ctx.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
  }
}
const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };

/* All stamps for a page, in display coordinates of viewport vp.
   Each: {img, cx, cy, a (visual degrees, counter-clockwise), op} */
function stampList(p, pg, vp, n, total, set) {
  const s = vp.scale, R = totalRot(pg, p), out = [];
  for (const o of p.overlays) {
    if (!o.text.trim()) continue;
    const [cx, cy] = overlayCenter(o, vp, R);
    out.push({ img: textImage(o.text, o.size, o.color, o.bold), cx, cy, a: o.ang - R, op: 1 });
  }
  if (set.wm.on && set.wm.text.trim()) {
    out.push({ img: textImage(set.wm.text, set.wm.size, set.wm.color, true), cx: vp.width / 2, cy: vp.height / 2, a: set.wm.angle, op: set.wm.opacity });
  }
  if (set.pn.on) {
    const img = textImage(pageNumberText(set.pn.fmt, n + set.pn.start, total + set.pn.start - 1), set.pn.size, '#333333', false);
    const m = 28 * s, iw = img.w * s;
    let cx = vp.width / 2, cy = vp.height - m;
    if (set.pn.pos === 'br') cx = vp.width - m - iw / 2;
    if (set.pn.pos === 'bl') cx = m + iw / 2;
    if (set.pn.pos === 'tc') cy = m;
    out.push({ img, cx, cy, a: 0, op: 1 });
  }
  return out;
}
function drawStamps(ctx, list, s) {
  for (const st of list) {
    ctx.save();
    ctx.globalAlpha = st.op;
    ctx.translate(st.cx, st.cy);
    ctx.rotate(-st.a * Math.PI / 180);
    ctx.drawImage(st.img.canvas, -st.img.w * s / 2, -st.img.h * s / 2, st.img.w * s, st.img.h * s);
    ctx.restore();
  }
}

/* ---------- Loading files ---------- */
async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) { toast('אפשר להוסיף רק קובצי PDF'); return; }
  busy(true, 'קורא את הקבצים…');
  let added = 0;
  const before = JSON.stringify(state.pages);
  for (const f of files) {
    try {
      if (f.size > MAX_FILE_BYTES) { toast(`"${f.name}" גדול מדי (מעל ${MAX_FILE_BYTES / 1024 / 1024} MB).`, 5000); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!looksLikePdf(bytes)) { toast(`"${f.name}" אינו קובץ PDF תקין.`, 5000); continue; }
      await addBytes(bytes, f.name);
      added++;
    } catch (e) {
      console.error(e);
      const msg = e && e.name === 'PasswordException' ? `הקובץ "${f.name}" מוגן בסיסמה. הסירו את הסיסמה ונסו שוב.` : `לא הצלחתי לפתוח את "${f.name}". ייתכן שהקובץ פגום.`;
      toast(msg, 5000);
    }
  }
  if (added) { history.push(before); $('undoBtn').disabled = false; }
  busy(false);
  renderGrid();
}
async function addBytes(bytes, name) {
  const s0 = state.pages.length > 0;
  const pdf = await pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,          // never compile code from inside a PDF
    enableXfa: false,
    cMapUrl: 'vendor/cmaps/', cMapPacked: true,
    standardFontDataUrl: 'vendor/standard_fonts/',
  }).promise;
  const src = state.sources.length;
  state.sources.push({ name, bytes, pdf, cache: new Map() });
  for (let i = 0; i < pdf.numPages; i++) state.pages.push({ id: uid++, src, idx: i, rot: 0, overlays: [], rects: [] });
  if ($('fileName').dataset.auto !== 'no') {
    const merged = new Set(state.pages.map(p => p.src)).size > 1;
    if (!merged || !s0) $('fileName').value = name.replace(/\.pdf$/i, '') + (merged ? '-ממוזג' : '-ערוך') + '.pdf';
    else $('fileName').value = $('fileName').value.replace(/-ערוך\.pdf$/, '-ממוזג.pdf');
  }
}

async function makeSample() {
  busy(true, 'יוצר קובץ לדוגמה…');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const titles = ['Quarterly Report', 'Revenue by Region', 'Customer Survey', 'Appendix'];
  titles.forEach((t, i) => {
    const page = doc.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 0, y: 781, width: 595.28, height: 61, color: rgb(0.06, 0.42, 0.45) });
    page.drawText('SAMPLE DOCUMENT', { x: 48, y: 805, size: 14, font: bold, color: rgb(1, 1, 1) });
    page.drawText(t, { x: 48, y: 720, size: 30, font: bold, color: rgb(0.1, 0.13, 0.17) });
    for (let l = 0; l < 14; l++) {
      const w = 420 + ((l * 37 + i * 53) % 80);
      page.drawRectangle({ x: 48, y: 670 - l * 26, width: w, height: 8, color: rgb(0.85, 0.87, 0.9) });
    }
    if (i === 1) [120, 180, 90, 210].forEach((h, b) => page.drawRectangle({ x: 70 + b * 110, y: 120, width: 70, height: h, color: rgb(0.76 - b * 0.12, 0.26 + b * 0.1, 0.05 + b * 0.15) }));
    page.drawText(`Page ${i + 1}`, { x: 500, y: 40, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  });
  const bytes = await doc.save();
  const before = JSON.stringify(state.pages);
  await addBytes(bytes, 'דוגמה.pdf');
  history.push(before); $('undoBtn').disabled = false;
  busy(false);
  renderGrid();
  toast('נטען קובץ לדוגמה עם 4 עמודים');
}

/* ---------- Grid ---------- */
let renderSeq = 0;
function renderGrid() {
  const has = state.pages.length > 0;
  $('workspace').hidden = !has;
  $('drop').classList.toggle('compact', has);
  $('dropTitle').textContent = has ? 'להוספת קבצים: גררו לכאן או' : 'גררו לכאן קובצי PDF';
  $('sampleBtn').hidden = has;
  $('downloadBtn').disabled = !has;
  updateToolbar();

  const grid = $('grid');
  const set = settings();
  const total = state.pages.length;
  const seq = ++renderSeq;
  const frag = document.createDocumentFragment();
  state.pages.forEach((p, n) => {
    const src = state.sources[p.src];
    const card = document.createElement('div');
    card.className = 'card' + (state.selected.has(p.id) ? ' selected' : '');
    card.draggable = true;
    card.dataset.id = p.id;
    card.innerHTML = `
      <button class="sheet" type="button" aria-pressed="${state.selected.has(p.id)}" aria-label="עמוד ${n + 1}, לחצו לבחירה">
        <span class="ph"></span><span class="check">${state.selected.has(p.id) ? '✓' : ''}</span>
      </button>
      <div class="meta"><span class="num">${n + 1}</span>
        <span class="src" title="${escapeHtml(src.name)} · עמוד ${p.idx + 1}"><i class="dot"></i>${escapeHtml(src.name.replace(/\.pdf$/i, ''))} · ${p.idx + 1}</span></div>
      <div class="size"></div>
      <div class="acts">
        <button class="ic" data-act="left" title="הזזה קדימה" aria-label="הזזה קדימה">→</button>
        <button class="ic" data-act="right" title="הזזה אחורה" aria-label="הזזה אחורה">←</button>
        <button class="ic" data-act="rotl" title="סיבוב שמאלה" aria-label="סיבוב שמאלה">↺</button>
        <button class="ic" data-act="rotr" title="סיבוב ימינה" aria-label="סיבוב ימינה">↻</button>
        <button class="ic" data-act="edit" title="הוספת טקסט" aria-label="הוספת טקסט">✎</button>
        <button class="ic" data-act="dup" title="שכפול" aria-label="שכפול">⧉</button>
        <button class="ic del" data-act="del" title="מחיקה" aria-label="מחיקה">✕</button>
      </div>`;
    card.querySelector('.dot').style.background = SRC_COLORS[p.src % SRC_COLORS.length];
    frag.appendChild(card);
    fillThumb(card, p, n, total, set, seq);
  });
  grid.replaceChildren(frag);
  $('countLabel').textContent = `${total} עמודים · ${new Set(state.pages.map(p => p.src)).size} קבצים` + (state.selected.size ? ` · ${state.selected.size} נבחרו` : '');
}
function updateToolbar() {
  const any = state.selected.size > 0;
  document.querySelectorAll('[data-needsel]').forEach(b => b.disabled = !any);
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const THUMB_CSS = 150;
async function fillThumb(card, p, n, total, set, seq) {
  const pg = await getPage(p.src, p.idx);
  const R = totalRot(pg, p);
  const base = pg.getViewport({ scale: 1, rotation: R });
  card.querySelector('.size').textContent = paperName(base.width, base.height);
  const key = JSON.stringify([R, p.overlays, p.rects || [], set.wm, set.pn.on ? [set.pn, n, total] : 0]);
  const cached = thumbCache.get(p.id);
  let canvas;
  if (cached && cached.key === key) canvas = cached.canvas;
  else {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = THUMB_CSS * dpr / Math.max(base.width, base.height);
    const vp = pg.getViewport({ scale, rotation: R });
    canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    canvas.style.width = (vp.width / dpr) + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    try { await pg.render({ canvasContext: ctx, viewport: vp }).promise; } catch (e) { console.warn(e); }
    drawRects(ctx, p, vp);
    drawStamps(ctx, stampList(p, pg, vp, n, total, set), scale);
    thumbCache.set(p.id, { key, canvas });
  }
  if (seq !== renderSeq) return;
  const sheet = card.querySelector('.sheet');
  const ph = sheet.querySelector('.ph, canvas');
  if (ph) ph.replaceWith(canvas); else sheet.prepend(canvas);
}

/* ---------- Page actions ---------- */
const idxOf = (id) => state.pages.findIndex(p => p.id === id);
function cloneWithNewIds(p) {
  const map = new Map();
  const rects = (p.rects || []).map(r => { const id = uid++; map.set(r.id, id); return { ...r, id }; });
  return { ...p, id: uid++, rects, overlays: p.overlays.map(o => ({ ...o, id: uid++, rectId: o.rectId ? map.get(o.rectId) : undefined })) };
}
function rotate(ids, delta) {
  snapshot();
  for (const p of state.pages) if (ids.has(p.id)) p.rot = ((p.rot + delta) % 360 + 360) % 360;
  renderGrid();
}
function removePages(ids) {
  snapshot();
  state.pages = state.pages.filter(p => !ids.has(p.id));
  for (const id of ids) state.selected.delete(id);
  renderGrid();
  toast(ids.size === 1 ? 'העמוד נמחק' : `${ids.size} עמודים נמחקו`);
}
function duplicate(ids) {
  snapshot();
  const out = [];
  for (const p of state.pages) { out.push(p); if (ids.has(p.id)) out.push(cloneWithNewIds(p)); }
  state.pages = out;
  renderGrid();
}
function move(id, to) {
  const from = idxOf(id);
  if (from < 0 || to < 0 || to >= state.pages.length || to === from) return;
  snapshot();
  const [p] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, p);
  renderGrid();
}

$('grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const id = +card.dataset.id;
  const actBtn = e.target.closest('[data-act]');
  if (!actBtn) {
    if (e.target.closest('.sheet')) {
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      renderGrid();
    }
    return;
  }
  const one = new Set([id]);
  switch (actBtn.dataset.act) {
    case 'left': move(id, idxOf(id) - 1); break;
    case 'right': move(id, idxOf(id) + 1); break;
    case 'rotl': rotate(one, -90); break;
    case 'rotr': rotate(one, 90); break;
    case 'dup': duplicate(one); break;
    case 'del': removePages(one); break;
    case 'edit': openEditor(id); break;
  }
});
$('grid').addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (card && e.target.closest('.sheet')) openEditor(+card.dataset.id);
});

/* Drag to reorder (pages) and drag-in files (anywhere) */
let dragId = null;
$('grid').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  dragId = +card.dataset.id; card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragId));
});
$('grid').addEventListener('dragend', () => {
  dragId = null;
  document.querySelectorAll('.card').forEach(c => c.classList.remove('dragging', 'drop-before', 'drop-after'));
});
function dropSide(card, e) {
  const r = card.getBoundingClientRect();
  // RTL: the right half means "before"
  return (e.clientX > r.left + r.width / 2) ? 'before' : 'after';
}
$('grid').addEventListener('dragover', (e) => {
  if (dragId == null) return;
  const card = e.target.closest('.card'); if (!card) return;
  e.preventDefault();
  document.querySelectorAll('.card').forEach(c => c.classList.remove('drop-before', 'drop-after'));
  if (+card.dataset.id !== dragId) card.classList.add('drop-' + dropSide(card, e));
});
$('grid').addEventListener('drop', (e) => {
  if (dragId == null) return;
  e.preventDefault(); e.stopPropagation();
  const card = e.target.closest('.card');
  if (card && +card.dataset.id !== dragId) {
    const from = idxOf(dragId);
    let to = idxOf(+card.dataset.id) + (dropSide(card, e) === 'after' ? 1 : 0);
    if (from < to) to--;
    move(dragId, to);
  }
  dragId = null;
});
let fileDragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { fileDragDepth++; document.body.classList.add('dragging-files'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --fileDragDepth <= 0) { fileDragDepth = 0; document.body.classList.remove('dragging-files'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); fileDragDepth = 0; document.body.classList.remove('dragging-files');
  addFiles(e.dataTransfer.files);
});

/* ---------- Toolbar ---------- */
$('pickBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('sampleBtn').onclick = makeSample;
$('undoBtn').onclick = undo;
$('selAllBtn').onclick = () => { state.pages.forEach(p => state.selected.add(p.id)); renderGrid(); };
$('selNoneBtn').onclick = () => { state.selected.clear(); renderGrid(); };
$('rotLBtn').onclick = () => rotate(new Set(state.selected), -90);
$('rotRBtn').onclick = () => rotate(new Set(state.selected), 90);
$('dupBtn').onclick = () => duplicate(new Set(state.selected));
$('delBtn').onclick = () => removePages(new Set(state.selected));
$('clearBtn').onclick = () => {
  snapshot(); state.pages = []; state.selected.clear(); renderGrid();
  toast('כל העמודים הוסרו. אפשר לבטל עם "ביטול פעולה".', 4000);
};
$('fileName').addEventListener('input', () => $('fileName').dataset.auto = 'no');
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
});

/* Settings panel */
let settingsTimer;
function onSettings() {
  $('wmOpacityVal').textContent = $('wmOpacity').value + '%';
  $('wmGroup').classList.toggle('disabled-group', !$('wmOn').checked);
  $('pnGroup').classList.toggle('disabled-group', !$('pnOn').checked);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(renderGrid, 180);
}
['wmOn', 'wmText', 'wmSize', 'wmColor', 'wmOpacity', 'wmAngle', 'pnOn', 'pnFmt', 'pnPos', 'pnSize', 'pnStart']
  .forEach(id => { $(id).addEventListener('input', onSettings); $(id).addEventListener('change', onSettings); });

/* ---------- Export ---------- */
async function buildPdf(pages) {
  const set = settings();
  const out = await PDFDocument.create();
  const srcDocs = new Map();
  const embedded = new Map();
  for (let n = 0; n < pages.length; n++) {
    const p = pages[n];
    if (!srcDocs.has(p.src)) srcDocs.set(p.src, await PDFDocument.load(state.sources[p.src].bytes, { ignoreEncryption: true }));
    const [page] = await out.copyPages(srcDocs.get(p.src), [p.idx]);
    out.addPage(page);
    const pg = await getPage(p.src, p.idx);
    const R = totalRot(pg, p);
    page.setRotation(degrees(R));
    const vp = pg.getViewport({ scale: 1, rotation: R });
    for (const r of p.rects || []) {
      page.drawRectangle({ x: r.x1, y: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1, color: hexRgb(r.color), borderWidth: 0 });
    }
    for (const st of stampList(p, pg, vp, n, pages.length, set)) {
      let img = embedded.get(st.img.key);
      if (!img) { img = await out.embedPng(st.img.canvas.toDataURL('image/png')); embedded.set(st.img.key, img); }
      const [ux, uy] = vp.convertToPdfPoint(st.cx, st.cy);
      const th = (st.a + R) * Math.PI / 180;   // angle in PDF user space (counter-clockwise)
      const hw = st.img.w / 2, hh = st.img.h / 2;
      const x = ux - (hw * Math.cos(th) - hh * Math.sin(th));
      const y = uy - (hw * Math.sin(th) + hh * Math.cos(th));
      page.drawImage(img, { x, y, width: st.img.w, height: st.img.h, rotate: degrees(st.a + R), opacity: st.op });
    }
  }
  out.setProducer('דפדף');
  return out.save();
}
function saveBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function outName(suffix = '') {
  let n = ($('fileName').value || 'מסמך').trim().replace(/[\\/:*?"<>|]/g, '_');
  n = n.replace(/\.pdf$/i, '');
  return n + suffix + '.pdf';
}
async function exportPages(pages, name) {
  busy(true, `מכין קובץ עם ${pages.length} עמודים…`);
  try {
    const bytes = await buildPdf(pages);
    saveBytes(bytes, name);
    toast(`הקובץ "${name}" ירד (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`, 4000);
  } catch (e) {
    console.error(e);
    toast('יצירת הקובץ נכשלה. אם הקובץ המקורי מוגן או מוצפן, נסו קובץ אחר.', 6000);
  } finally { busy(false); }
}
$('downloadBtn').onclick = () => state.pages.length && exportPages(state.pages, outName());
$('extractBtn').onclick = () => {
  const pages = state.pages.filter(p => state.selected.has(p.id));
  if (pages.length) exportPages(pages, outName('-עמודים-נבחרים'));
};

/* ---------- Page editor: new text, edit existing text, erase area ---------- */
const ed = { pid: null, selId: null, selRect: null, vp: null, pg: null, base: null, R: 0, scale: 1, fit: 1, zoom: 1, renderTok: 0, canvas: null, drag: null, draw: null, tap: null, pinch: null, mode: 'text', items: [] };
const edPage = () => state.pages.find(p => p.id === ed.pid);
const edSel = () => edPage()?.overlays.find(o => o.id === ed.selId);
const HINTS = {
  text: 'כתבו טקסט בשדה למעלה ולחצו על העמוד כדי להוסיף אותו. גוררים טקסט כדי להזיז אותו.',
  edit: 'לחצו על טקסט מסומן בעמוד כדי לשנות אותו. כדי למחוק מילה, מוחקים את כל הטקסט בשדה. ✕ מחזיר את המקור.',
  erase: 'גררו מלבן על האזור שרוצים למחוק. הכיסוי מקבל את צבע הרקע של הדף. שימו לב: הטקסט המקורי נשאר בתוך הקובץ מתחת לכיסוי, ולכן זה לא מתאים להסתרת מידע רגיש.',
};

async function openEditor(id) {
  ed.pid = id; ed.selId = null; ed.selRect = null; cancelGestures(); ed.pinch = null; pointers.clear();
  if (!$('editor').open) $('editor').showModal();
  await drawEditor();
}
function setMode(m) {
  ed.mode = m; ed.selId = null; ed.selRect = null;
  document.querySelectorAll('#edModes .mode').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('stage').dataset.mode = m;
  $('edTextTools').classList.toggle('off', m === 'erase');
  drawOverlays();
}
async function drawEditor() {
  const p = edPage(); if (!p) return;
  const n = idxOf(p.id);
  $('edTitle').textContent = `עריכת עמוד ${n + 1} מתוך ${state.pages.length}`;
  $('edPrev').disabled = n <= 0; $('edNext').disabled = n >= state.pages.length - 1;
  const pg = await getPage(p.src, p.idx);
  const R = totalRot(pg, p);
  // The page's own text, so it can be clicked and replaced
  let items = [];
  try {
    const tc = await pg.getTextContent();
    items = tc.items.map((it, i) => ({ ...it, i })).filter(it =>
      it.str && it.str.trim() && Math.abs(it.transform[1]) < 0.01 && Math.abs(it.transform[2]) < 0.01 && it.transform[0] > 0 && it.width > 0);
  } catch (e) { console.warn(e); }
  if (ed.pid !== p.id) return;
  const pageChanged = ed.pg !== pg || ed.R !== R;
  Object.assign(ed, { pg, R, items, base: pg.getViewport({ scale: 1, rotation: R }) });
  computeFit();
  if (pageChanged) { $('stage').querySelector('canvas')?.remove(); ed.canvas = null; }
  layoutEditor();
  await renderBitmap();
}
function computeFit() {
  const body = $('edBody');
  const availW = Math.max(200, Math.min(900, (body.clientWidth || window.innerWidth) - 32));
  const availH = Math.max(280, (body.clientHeight || window.innerHeight - 300) - 32);
  ed.fit = Math.min(availW / ed.base.width, availH / ed.base.height, 2.5);
}
/* Size the page for the current zoom; the old bitmap is stretched until the sharp one is ready */
function layoutEditor() {
  const scale = ed.fit * ed.zoom;
  ed.vp = ed.pg.getViewport({ scale, rotation: ed.R });
  ed.scale = scale;
  const stage = $('stage');
  stage.style.width = ed.vp.width + 'px'; stage.style.height = ed.vp.height + 'px';
  const c = stage.querySelector('canvas');
  if (c) { c.style.width = ed.vp.width + 'px'; c.style.height = ed.vp.height + 'px'; }
  $('zoomLabel').textContent = Math.round(ed.zoom * 100) + '%';
  $('zoomOut').disabled = ed.zoom <= ZOOM_MIN + 1e-6;
  $('zoomIn').disabled = ed.zoom >= ZOOM_MAX - 1e-6;
  drawOverlays();
}
async function renderBitmap() {
  const tok = ++ed.renderTok;
  const vp = ed.vp, pg = ed.pg;
  // Sharp on high-density screens, but never a canvas bigger than phones allow
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const k = Math.min(dpr, Math.sqrt(14e6 / (vp.width * vp.height)));
  const hi = pg.getViewport({ scale: ed.scale * k, rotation: ed.R });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(hi.width); canvas.height = Math.ceil(hi.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  try { await pg.render({ canvasContext: ctx, viewport: hi }).promise; } catch (e) { console.warn(e); return; }
  if (tok !== ed.renderTok || pg !== ed.pg) return;
  canvas.style.width = ed.vp.width + 'px'; canvas.style.height = ed.vp.height + 'px';
  const old = $('stage').querySelector('canvas');
  if (old) old.replaceWith(canvas); else $('stage').prepend(canvas);
  ed.canvas = canvas;
}
let renderTimer;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderBitmap, 180); }

/* ---- Zoom ---- */
const ZOOM_MIN = 0.5, ZOOM_MAX = 6;
const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
/* Zoom so that the point at fraction (fx, fy) of the page ends up under screen point (cx, cy) */
function zoomAt(z, fx, fy, cx, cy) {
  if (!ed.pg) return;
  ed.zoom = clampZoom(z);
  layoutEditor();
  const body = $('edBody'), r = $('stage').getBoundingClientRect();
  body.scrollLeft += (r.left + fx * r.width) - cx;
  body.scrollTop += (r.top + fy * r.height) - cy;
  scheduleRender();
}
function zoomAround(z, cx, cy) {
  const br = $('edBody').getBoundingClientRect();
  if (cx == null) { cx = br.left + br.width / 2; cy = br.top + br.height / 2; }
  const r = $('stage').getBoundingClientRect();
  const fx = Math.max(0, Math.min(1, (cx - r.left) / r.width)), fy = Math.max(0, Math.min(1, (cy - r.top) / r.height));
  zoomAt(z, fx, fy, cx, cy);
}
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6];
$('zoomIn').onclick = () => zoomAround(ZOOM_STEPS.find(z => z > ed.zoom + 0.01) ?? ZOOM_MAX);
$('zoomOut').onclick = () => zoomAround([...ZOOM_STEPS].reverse().find(z => z < ed.zoom - 0.01) ?? ZOOM_MIN);
$('zoomFit').onclick = () => { ed.zoom = 1; layoutEditor(); scheduleRender(); };
$('edBody').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;   // trackpad pinch also arrives as ctrl+wheel
  e.preventDefault();
  zoomAround(ed.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
}, { passive: false });

/* Bounding box of a text item, in PDF user space */
function itemBox(it) {
  const h = Math.hypot(it.transform[2], it.transform[3]) || it.height;
  const x = it.transform[4], y = it.transform[5];
  return { x1: x - h * 0.05, y1: y - h * 0.28, x2: x + it.width + h * 0.05, y2: y + h * 0.95, h };
}
function toView(r) {
  const [a, b, c, d] = ed.vp.convertToViewportRectangle([r.x1, r.y1, r.x2, r.y2]);
  return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}
/* Background colour next to an area of the rendered page (the lightest of the points around it) */
function sampleBg(v) {
  if (!ed.canvas) return '#ffffff';
  const ctx = ed.canvas.getContext('2d', { willReadFrequently: true });
  const k = ed.canvas.width / ed.vp.width, pts = [];
  const xs = [v.left - 3, v.left + v.width / 2, v.left + v.width + 3], ys = [v.top - 3, v.top + v.height / 2, v.top + v.height + 3];
  for (const x of xs) for (const y of ys) {
    if (x === xs[1] && y === ys[1]) continue;
    const px = Math.round(x * k), py = Math.round(y * k);
    if (px < 0 || py < 0 || px >= ed.canvas.width || py >= ed.canvas.height) continue;
    pts.push(ctx.getImageData(px, py, 1, 1).data);
  }
  if (!pts.length) return '#ffffff';
  pts.sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2]));
  const c = pts[0];
  return '#' + [c[0], c[1], c[2]].map(n => n.toString(16).padStart(2, '0')).join('');
}
function textColorInside(v) {
  if (!ed.canvas) return '#000000';
  // darkest pixel inside the box = the original ink colour
  const ctx = ed.canvas.getContext('2d', { willReadFrequently: true });
  const k = ed.canvas.width / ed.vp.width;
  const x = Math.max(0, Math.round(v.left * k)), y = Math.max(0, Math.round(v.top * k));
  const w = Math.max(1, Math.min(ed.canvas.width - x, Math.round(v.width * k))), h = Math.max(1, Math.min(ed.canvas.height - y, Math.round(v.height * k)));
  const d = ctx.getImageData(x, y, w, h).data;
  let best = 765, col = [0, 0, 0];
  for (let i = 0; i < d.length; i += 16) { const s = d[i] + d[i + 1] + d[i + 2]; if (s < best) { best = s; col = [d[i], d[i + 1], d[i + 2]]; } }
  return '#' + col.map(n => n.toString(16).padStart(2, '0')).join('');
}

function positionOv(el, o) {
  const [cx, cy] = overlayCenter(o, ed.vp, ed.R);
  el.style.left = cx + 'px'; el.style.top = cy + 'px';
}
function drawOverlays() {
  const stage = $('stage'), p = edPage(); if (!p || !ed.vp) return;
  stage.querySelectorAll('.ov, .er, .ti').forEach(el => el.remove());
  const rects = p.rects || [];
  for (const r of rects) {
    const v = toView(r);
    const el = document.createElement('div');
    el.className = 'er' + (r.id === ed.selRect ? ' sel' : '');
    el.dataset.id = r.id;
    Object.assign(el.style, { left: v.left + 'px', top: v.top + 'px', width: v.width + 'px', height: v.height + 'px', background: r.color });
    if (!r.link) el.appendChild(xButton('ביטול המחיקה'));
    stage.appendChild(el);
  }
  if (ed.mode === 'edit') {
    const used = new Set(p.overlays.filter(o => o.srcItem != null).map(o => o.srcItem));
    for (const it of ed.items) {
      if (used.has(it.i)) continue;
      const v = toView(itemBox(it));
      const el = document.createElement('div');
      el.className = 'ti'; el.dataset.i = it.i; el.title = it.str;
      Object.assign(el.style, { left: v.left + 'px', top: v.top + 'px', width: v.width + 'px', height: v.height + 'px' });
      stage.appendChild(el);
    }
  }
  for (const o of p.overlays) {
    const el = document.createElement('div');
    el.className = 'ov' + (o.id === ed.selId ? ' sel' : '');
    el.dataset.id = o.id;
    el.dir = isHebrew(o.text) ? 'rtl' : 'ltr';
    positionOv(el, o);
    el.style.transform = `translate(-50%, -50%) rotate(${-(o.ang - ed.R)}deg)`;
    el.style.fontSize = (o.size * ed.scale) + 'px';
    el.style.fontWeight = o.bold ? 700 : 400;
    el.style.color = o.color;
    el.textContent = o.text || ' ';
    if (!o.text) el.classList.add('empty');
    el.appendChild(xButton(o.srcItem != null ? 'החזרת הטקסט המקורי' : 'מחיקת הטקסט'));
    stage.appendChild(el);
  }
  $('edHint').textContent = ed.selId
    ? 'הטקסט המסומן מתעדכן לפי השדות למעלה. גררו כדי להזיז. ✕ מבטל אותו. לחיצה על אזור ריק מבטלת את הסימון.'
    : HINTS[ed.mode];
  if (ed.mode === 'edit' && !ed.items.length) $('edHint').textContent = 'לא נמצא בעמוד הזה טקסט שאפשר לערוך (ייתכן שזה מסמך סרוק). אפשר למחוק אזור ולכתוב מעליו טקסט חדש.';
}
function xButton(label) {
  const b = document.createElement('button');
  b.className = 'x'; b.type = 'button'; b.textContent = '✕'; b.setAttribute('aria-label', label);
  return b;
}
function stagePoint(e) {
  const r = $('stage').getBoundingClientRect();
  return [Math.max(0, Math.min(ed.vp.width, e.clientX - r.left)), Math.max(0, Math.min(ed.vp.height, e.clientY - r.top))];
}
function loadFields(o) {
  $('edText').value = o.text; $('edSize').value = Math.round(o.size * 10) / 10; $('edColor').value = o.color; $('edBold').checked = o.bold;
}
function removeOverlay(p, id) {
  const o = p.overlays.find(x => x.id === id);
  p.overlays = p.overlays.filter(x => x.id !== id);
  if (o && o.rectId) p.rects = (p.rects || []).filter(r => r.id !== o.rectId);
}

function replaceItem(p, it) {
  snapshot();
  const box = itemBox(it);
  const v = toView(box);
  const rect = { id: uid++, x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, color: sampleBg(v), link: true };
  p.rects = p.rects || [];
  p.rects.push(rect);
  const rtl = isHebrew(it.str) || it.dir === 'rtl';
  const midY = it.transform[5] + box.h * 0.33;
  const o = {
    id: uid++, text: it.str, size: Math.round(box.h * 10) / 10, color: textColorInside(v), bold: /bold|black|heavy/i.test(it.fontName || ''),
    px: rtl ? it.transform[4] + it.width : it.transform[4], py: midY, ang: 0, anchor: rtl ? 'r' : 'l',
    srcItem: it.i, rectId: rect.id,
  };
  p.overlays.push(o);
  ed.selId = o.id; ed.selRect = null;
  loadFields(o);
  drawOverlays();
  $('edText').focus(); $('edText').select();
}

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
  if (e.button > 0) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { $('stage').setPointerCapture(e.pointerId); } catch (_) {}
  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;
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
    ed.selId = o.id; ed.selRect = null;
    loadFields(o);
    const [x, y] = ed.vp.convertToViewportPoint(o.px, o.py);
    const [mx, my] = stagePoint(e);
    ed.drag = { o, dx: mx - x, dy: my - y, moved: false };
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
  if (ed.selId || ed.selRect) {
    ed.selId = null; ed.selRect = null; drawOverlays();
    if (ed.mode !== 'erase') { startTap(e, 'none'); return; }
  }
  if (ed.mode === 'erase') {
    const [x, y] = stagePoint(e);
    const el = document.createElement('div');
    el.className = 'er drawing';
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
  const el = $('stage').querySelector(`.ov[data-id="${ed.drag.o.id}"]`);
  if (el) positionOv(el, ed.drag.o);
});
function doTap(t, e) {
  const p = edPage(); if (!p) return;
  if (t.kind === 'ti') {
    const it = ed.items.find(x => x.i === t.i);
    if (it) replaceItem(p, it);
    return;
  }
  if (t.kind !== 'add') return;
  const text = $('edText').value;
  if (!text.trim()) { toast('כתבו קודם טקסט בשדה למעלה'); $('edText').focus(); return; }
  snapshot();
  const [x, y] = stagePoint(e);
  const [px, py] = ed.vp.convertToPdfPoint(x, y);
  const o = { id: uid++, text, size: +$('edSize').value || 18, color: $('edColor').value, bold: $('edBold').checked, px, py, ang: ed.R };
  p.overlays.push(o);
  ed.selId = o.id;
  drawOverlays();
}
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (ed.pinch) { if (pointers.size < 2) ed.pinch = null; return; }
  if (ed.tap) {
    const t = ed.tap; ed.tap = null;
    if (!t.pan && e.type === 'pointerup') doTap(t, e);
    return;
  }
  ed.drag = null;
  const d = ed.draw; if (!d) return;
  ed.draw = null;
  d.el.remove();
  if (e.type !== 'pointerup') return;
  const w = Math.abs(d.x - d.x0), h = Math.abs(d.y - d.y0);
  if (w < 4 || h < 4) return;
  const p = edPage();
  const v = { left: Math.min(d.x0, d.x), top: Math.min(d.y0, d.y), width: w, height: h };
  const [ax, ay] = ed.vp.convertToPdfPoint(v.left, v.top);
  const [bx, by] = ed.vp.convertToPdfPoint(v.left + w, v.top + h);
  snapshot();
  p.rects = p.rects || [];
  const r = { id: uid++, x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by), color: sampleBg(v) };
  p.rects.push(r);
  ed.selRect = r.id;
  drawOverlays();
}
$('stage').addEventListener('pointerup', endPointer);
$('stage').addEventListener('pointercancel', endPointer);

let edSnapTaken = false;
['edText', 'edSize', 'edColor', 'edBold'].forEach(id => {
  $(id).addEventListener('focus', () => { edSnapTaken = false; });
  $(id).addEventListener('input', () => {
    const o = edSel(); if (!o) return;
    if (!edSnapTaken) { snapshot(); edSnapTaken = true; }
    o.text = $('edText').value; o.size = +$('edSize').value || o.size; o.color = $('edColor').value; o.bold = $('edBold').checked;
    drawOverlays();
  });
});
document.querySelectorAll('#edModes .mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('editor').addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && (ed.selId || ed.selRect)) {
    e.preventDefault(); snapshot();
    const p = edPage();
    if (ed.selId) removeOverlay(p, ed.selId); else p.rects = (p.rects || []).filter(r => r.id !== ed.selRect);
    ed.selId = null; ed.selRect = null; drawOverlays();
  }
});
$('edClose').onclick = () => $('editor').close();
$('editor').addEventListener('close', () => { ed.pid = null; renderGrid(); });
$('edPrev').onclick = () => { const n = idxOf(ed.pid); if (n > 0) openEditor(state.pages[n - 1].id); };
$('edNext').onclick = () => { const n = idxOf(ed.pid); if (n < state.pages.length - 1) openEditor(state.pages[n + 1].id); };
window.addEventListener('resize', () => { if ($('editor').open && ed.pg) { clearTimeout(ed.rt); ed.rt = setTimeout(() => { computeFit(); layoutEditor(); scheduleRender(); }, 200); } });

/* Make sure the Hebrew font is ready before drawing text into canvases */
if (document.fonts && document.fonts.load) {
  Promise.all([document.fonts.load(`400 20px Heebo`), document.fonts.load(`700 20px Heebo`)])
    .then(() => { textImgCache.clear(); thumbCache.clear(); if (state.pages.length) renderGrid(); })
    .catch(() => {});
}
onSettings();
renderGrid();
})();
