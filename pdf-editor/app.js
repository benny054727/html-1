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

/* All stamps for a page, in display coordinates of viewport vp.
   Each: {img, cx, cy, a (visual degrees, counter-clockwise), op} */
function stampList(p, pg, vp, n, total, set) {
  const s = vp.scale, R = totalRot(pg, p), out = [];
  for (const o of p.overlays) {
    if (!o.text.trim()) continue;
    const [cx, cy] = vp.convertToViewportPoint(o.px, o.py);
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
  for (let i = 0; i < pdf.numPages; i++) state.pages.push({ id: uid++, src, idx: i, rot: 0, overlays: [] });
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
  const key = JSON.stringify([R, p.overlays, set.wm, set.pn.on ? [set.pn, n, total] : 0]);
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
  return { ...p, id: uid++, overlays: p.overlays.map(o => ({ ...o, id: uid++ })) };
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

/* ---------- Text editor ---------- */
const ed = { pid: null, selId: null, vp: null, R: 0, scale: 1, drag: null };
const edPage = () => state.pages.find(p => p.id === ed.pid);
const edSel = () => edPage()?.overlays.find(o => o.id === ed.selId);

async function openEditor(id) {
  ed.pid = id; ed.selId = null;
  if (!$('editor').open) $('editor').showModal();
  await drawEditor();
}
async function drawEditor() {
  const p = edPage(); if (!p) return;
  const n = idxOf(p.id);
  $('edTitle').textContent = `הוספת טקסט · עמוד ${n + 1} מתוך ${state.pages.length}`;
  $('edPrev').disabled = n <= 0; $('edNext').disabled = n >= state.pages.length - 1;
  const pg = await getPage(p.src, p.idx);
  const R = totalRot(pg, p);
  const base = pg.getViewport({ scale: 1, rotation: R });
  const availW = Math.min(900, window.innerWidth - 80);
  const availH = Math.max(320, window.innerHeight - 260);
  const scale = Math.min(availW / base.width, availH / base.height, 2.5);
  const vp = pg.getViewport({ scale, rotation: R });
  ed.vp = vp; ed.R = R; ed.scale = scale;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const hi = pg.getViewport({ scale: scale * dpr, rotation: R });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(hi.width); canvas.height = Math.ceil(hi.height);
  canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pg.render({ canvasContext: ctx, viewport: hi }).promise;
  if (ed.pid !== p.id) return;
  const stage = $('stage');
  stage.style.width = vp.width + 'px'; stage.style.height = vp.height + 'px';
  stage.replaceChildren(canvas);
  drawOverlays();
}
function drawOverlays() {
  const stage = $('stage'), p = edPage(); if (!p) return;
  stage.querySelectorAll('.ov').forEach(el => el.remove());
  for (const o of p.overlays) {
    const [x, y] = ed.vp.convertToViewportPoint(o.px, o.py);
    const el = document.createElement('div');
    el.className = 'ov' + (o.id === ed.selId ? ' sel' : '');
    el.dataset.id = o.id;
    el.dir = isHebrew(o.text) ? 'rtl' : 'ltr';
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.transform = `translate(-50%, -50%) rotate(${-(o.ang - ed.R)}deg)`;
    el.style.fontSize = (o.size * ed.scale) + 'px';
    el.style.fontWeight = o.bold ? 700 : 400;
    el.style.color = o.color;
    el.textContent = o.text || ' ';
    const x_ = document.createElement('button');
    x_.className = 'x'; x_.type = 'button'; x_.textContent = '✕'; x_.setAttribute('aria-label', 'מחיקת הטקסט');
    el.appendChild(x_);
    stage.appendChild(el);
  }
  $('edHint').textContent = ed.selId
    ? 'הטקסט המסומן מתעדכן לפי השדות למעלה. גררו כדי להזיז, ✕ למחיקה. לחיצה על אזור ריק מבטלת את הסימון.'
    : 'לחצו על העמוד כדי להוסיף את הטקסט. גוררים טקסט כדי להזיז אותו. לחיצה על טקסט קיים מאפשרת לשנות אותו.';
}
function stagePoint(e) {
  const r = $('stage').getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
$('stage').addEventListener('pointerdown', (e) => {
  const p = edPage(); if (!p) return;
  if (e.target.classList.contains('x')) {
    snapshot();
    const id = +e.target.parentElement.dataset.id;
    p.overlays = p.overlays.filter(o => o.id !== id);
    ed.selId = null; drawOverlays(); return;
  }
  const ovEl = e.target.closest('.ov');
  if (ovEl) {
    const o = p.overlays.find(x => x.id === +ovEl.dataset.id);
    ed.selId = o.id;
    $('edText').value = o.text; $('edSize').value = o.size; $('edColor').value = o.color; $('edBold').checked = o.bold;
    const [x, y] = ed.vp.convertToViewportPoint(o.px, o.py);
    const [mx, my] = stagePoint(e);
    ed.drag = { o, dx: mx - x, dy: my - y, moved: false };
    $('stage').setPointerCapture(e.pointerId);
    drawOverlays();
    return;
  }
  if (ed.selId) { ed.selId = null; drawOverlays(); return; }
  const text = $('edText').value;
  if (!text.trim()) { toast('כתבו קודם טקסט בשדה למעלה'); $('edText').focus(); return; }
  snapshot();
  const [x, y] = stagePoint(e);
  const [px, py] = ed.vp.convertToPdfPoint(x, y);
  const o = { id: uid++, text, size: +$('edSize').value || 18, color: $('edColor').value, bold: $('edBold').checked, px, py, ang: ed.R };
  p.overlays.push(o);
  ed.selId = o.id;
  drawOverlays();
});
$('stage').addEventListener('pointermove', (e) => {
  if (!ed.drag) return;
  if (!ed.drag.moved) { snapshot(); ed.drag.moved = true; }
  const [mx, my] = stagePoint(e);
  const x = Math.max(0, Math.min(ed.vp.width, mx - ed.drag.dx));
  const y = Math.max(0, Math.min(ed.vp.height, my - ed.drag.dy));
  [ed.drag.o.px, ed.drag.o.py] = ed.vp.convertToPdfPoint(x, y);
  const el = $('stage').querySelector(`.ov[data-id="${ed.drag.o.id}"]`);
  if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
});
const endDrag = () => { ed.drag = null; };
$('stage').addEventListener('pointerup', endDrag);
$('stage').addEventListener('pointercancel', endDrag);

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
$('editor').addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && ed.selId) {
    e.preventDefault(); snapshot();
    const p = edPage(); p.overlays = p.overlays.filter(o => o.id !== ed.selId); ed.selId = null; drawOverlays();
  }
});
$('edClose').onclick = () => $('editor').close();
$('editor').addEventListener('close', () => { ed.pid = null; renderGrid(); });
$('edPrev').onclick = () => { const n = idxOf(ed.pid); if (n > 0) openEditor(state.pages[n - 1].id); };
$('edNext').onclick = () => { const n = idxOf(ed.pid); if (n < state.pages.length - 1) openEditor(state.pages[n + 1].id); };
window.addEventListener('resize', () => { if ($('editor').open) { clearTimeout(ed.rt); ed.rt = setTimeout(drawEditor, 200); } });

/* Make sure the Hebrew font is ready before drawing text into canvases */
if (document.fonts && document.fonts.load) {
  Promise.all([document.fonts.load(`400 20px Heebo`), document.fonts.load(`700 20px Heebo`)])
    .then(() => { textImgCache.clear(); thumbCache.clear(); if (state.pages.length) renderGrid(); })
    .catch(() => {});
}
onSettings();
renderGrid();
})();
