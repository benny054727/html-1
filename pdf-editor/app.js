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
  if (edActive()) { if (!edPage()) leaveEditor(); else { ed.selId = null; drawEditor(); } }
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
  // the editor is a modal in the top layer, so show messages inside it while it is open
  const host = document.querySelector('dialog[open]') || document.body;
  if (t.parentElement !== host) host.appendChild(t);
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
/* Fonts bundled with the app. Each has Hebrew and Latin letters and digits.
   Arimo and Tinos have the same letter widths as Arial and Times New Roman. */
const FONT_GROUPS = ['דומים לגופני Word', 'עבריים קלאסיים', 'מודרניים', 'כתב יד ומיוחדים', 'דקורטיביים (לכותרות והזמנות)'];
const FONTS = {
  arimo:     { g: 0, label: 'Arial (אריאל)', family: 'Arimo' },
  tinos:     { g: 0, label: 'Times New Roman', family: 'Tinos' },
  cousine:   { g: 0, label: 'Courier New (מכונת כתיבה)', family: 'Cousine' },
  david:     { g: 0, label: 'David (דוד)', family: 'David Libre' },
  frank:     { g: 0, label: 'Frank Ruehl (פרנק רוהל)', family: 'Frank Ruhl Libre' },
  frankL:    { g: 0, label: 'Frank Ruehl דק', family: 'Frank Ruhl Libre', w: 300 },
  frankB:    { g: 0, label: 'Frank Ruehl שחור', family: 'Frank Ruhl Libre', w: 900 },
  miriam:    { g: 0, label: 'Miriam (מרים)', family: 'Miriam Libre' },
  alef:      { g: 0, label: 'אלף (Alef)', family: 'Alef' },
  notoserif: { g: 1, label: 'נוטו סריף (Noto Serif)', family: 'Noto Serif Hebrew' },
  notoserifL: { g: 1, label: 'נוטו סריף דק', family: 'Noto Serif Hebrew', w: 200 },
  notoserifB: { g: 1, label: 'נוטו סריף שחור', family: 'Noto Serif Hebrew', w: 900 },
  bellefair: { g: 1, label: 'בלפייר (Bellefair)', family: 'Bellefair' },
  bonanova:  { g: 1, label: 'בונה נובה (Bona Nova)', family: 'Bona Nova' },
  bonanovasc: { g: 1, label: 'בונה נובה – אותיות גדולות', family: 'Bona Nova SC' },
  rashi:     { g: 1, label: 'כתב רש״י (Noto Rashi)', family: 'Noto Rashi Hebrew' },
  heebo:     { g: 2, label: 'Heebo (היבו)', family: 'Heebo' },
  heeboL:    { g: 2, label: 'Heebo דק', family: 'Heebo', w: 200 },
  heeboXB:   { g: 2, label: 'Heebo ExtraBold (עבה מאוד)', family: 'Heebo', w: 800 },
  heeboB:    { g: 2, label: 'Heebo Black (שחור)', family: 'Heebo', w: 900 },
  assistant: { g: 2, label: 'Assistant (אסיסטנט)', family: 'Assistant' },
  assistantL: { g: 2, label: 'Assistant דק', family: 'Assistant', w: 200 },
  assistantB: { g: 2, label: 'Assistant כבד', family: 'Assistant', w: 800 },
  rubik:     { g: 2, label: 'Rubik (רוביק)', family: 'Rubik' },
  rubikL:    { g: 2, label: 'Rubik דק', family: 'Rubik', w: 300 },
  rubikB:    { g: 2, label: 'Rubik שחור', family: 'Rubik', w: 900 },
  opensans:  { g: 2, label: 'Open Sans', family: 'Open Sans' },
  opensansL: { g: 2, label: 'Open Sans דק', family: 'Open Sans', w: 300 },
  opensansB: { g: 2, label: 'Open Sans כבד', family: 'Open Sans', w: 800 },
  notosans:  { g: 2, label: 'Noto Sans (נוטו)', family: 'Noto Sans Hebrew' },
  notosansL: { g: 2, label: 'Noto Sans דק', family: 'Noto Sans Hebrew', w: 200 },
  notosansB: { g: 2, label: 'Noto Sans Hebrew Black (שחור)', family: 'Noto Sans Hebrew', w: 900 },
  plex:      { g: 2, label: 'IBM Plex (פלקס)', family: 'IBM Plex Sans Hebrew' },
  plexL:     { g: 2, label: 'IBM Plex דק', family: 'IBM Plex Sans Hebrew', w: 200 },
  varela:    { g: 2, label: 'Varela Round (מעוגל)', family: 'Varela Round' },
  fredoka:   { g: 2, label: 'Fredoka (פרדוקה)', family: 'Fredoka' },
  secular:   { g: 2, label: 'Secular One (כותרות)', family: 'Secular One' },
  suez:      { g: 2, label: 'Suez One (כותרות)', family: 'Suez One' },
  playpen:   { g: 3, label: 'כתב יד (Playpen)', family: 'Playpen Sans Hebrew' },
  amatic:    { g: 3, label: 'כתב יד צר (Amatic)', family: 'Amatic SC' },
  gveret:    { g: 3, label: 'גברת לוין (כתב יד)', family: 'Gveret Levin' },
  karantina: { g: 3, label: 'קרנטינה (Karantina)', family: 'Karantina' },
  solitreo:  { g: 3, label: 'סוליטראו (Solitreo)', family: 'Solitreo' },
  deco0: { g: 4, label: 'רוביק שנות ה־80', family: 'Rubik 80s Fade' },
  deco1: { g: 4, label: 'רוביק מפלצתי', family: 'Rubik Beastly' },
  deco2: { g: 4, label: 'רוביק פקס שבור', family: 'Rubik Broken Fax' },
  deco3: { g: 4, label: 'רוביק בועות', family: 'Rubik Bubbles' },
  deco4: { g: 4, label: 'רוביק שרוף', family: 'Rubik Burned' },
  deco5: { g: 4, label: 'רוביק מלוכלך', family: 'Rubik Dirt' },
  deco6: { g: 4, label: 'רוביק שחוק', family: 'Rubik Distressed' },
  deco7: { g: 4, label: 'רוביק שרבוט עם צל', family: 'Rubik Doodle Shadow' },
  deco8: { g: 4, label: 'רוביק משולשים', family: 'Rubik Doodle Triangles' },
  deco9: { g: 4, label: 'רוביק אבני חן', family: 'Rubik Gemstones' },
  deco10: { g: 4, label: 'רוביק גליץ׳', family: 'Rubik Glitch' },
  deco11: { g: 4, label: 'רוביק גליץ׳ פופ', family: 'Rubik Glitch Pop' },
  deco12: { g: 4, label: 'רוביק תלת־ממד', family: 'Rubik Iso' },
  deco13: { g: 4, label: 'רוביק קווים', family: 'Rubik Lines' },
  deco14: { g: 4, label: 'רוביק מפות', family: 'Rubik Maps' },
  deco15: { g: 4, label: 'רוביק טוש', family: 'Rubik Marker Hatch' },
  deco16: { g: 4, label: 'רוביק מבוך', family: 'Rubik Maze' },
  deco17: { g: 4, label: 'רוביק חיידקים', family: 'Rubik Microbe' },
  deco18: { g: 4, label: 'רוביק סלעי ירח', family: 'Rubik Moonrocks' },
  deco19: { g: 4, label: 'רוביק פיקסלים', family: 'Rubik Pixels' },
  deco20: { g: 4, label: 'רוביק שלוליות', family: 'Rubik Puddles' },
  deco21: { g: 4, label: 'רוביק קשקוש', family: 'Rubik Scribble' },
  deco22: { g: 4, label: 'רוביק ספריי', family: 'Rubik Spray Paint' },
  deco23: { g: 4, label: 'רוביק סערה', family: 'Rubik Storm' },
  deco24: { g: 4, label: 'רוביק ויניל', family: 'Rubik Vinyl' },
  deco25: { g: 4, label: 'רוביק צבע רטוב', family: 'Rubik Wet Paint' },
};
/* Fonts download only when they are first used */
const fontReady = new Map();
function ensureFont(k) {
  const f = FONTS[k]; if (!f || !document.fonts || !document.fonts.load) return Promise.resolve();
  if (!fontReady.has(k)) {
    fontReady.set(k, Promise.allSettled([...new Set([fontWeight(k, false), fontWeight(k, true)])].map(w => document.fonts.load(`${w} 20px "${f.family}"`, 'אבג abc 123')))
      .then(() => { textImgCache.clear(); thumbCache.clear(); }));
  }
  return fontReady.get(k);
}
function ensureFontsFor(pages) {
  const keys = new Set(['heebo']);
  for (const p of pages) for (const o of p.overlays) keys.add(o.font || 'heebo');
  return Promise.all([...keys].map(ensureFont));
}
const fontWeight = (k, bold) => { const w = (FONTS[k] || {}).w || 400; return bold ? Math.max(700, w) : w; };
const fontStack = (k) => `"${(FONTS[k] || FONTS.heebo).family}", Heebo, Arial, sans-serif`;

/* The text is drawn into an image with a known baseline (asc from the top), so it can sit exactly on a line */
function textImage(text, size, color, bold, fontKey, fx) {
  fx = fx || {};
  const key = [text, size, color, bold, fontKey || 'heebo', fx.it ? 1 : 0, fx.u ? 1 : 0, fx.st ? 1 : 0, fx.hl || '', fx.align || '', fx.lh || '', fx.ls || ''].join('\u0001');
  if (textImgCache.has(key)) return textImgCache.get(key);
  const font = `${fontWeight(fontKey, bold)} ${size}px ${fontStack(fontKey)}`;
  const ls = (fx.ls || 0) * size;
  const setLS = (ctx) => { if ('letterSpacing' in ctx) ctx.letterSpacing = ls + 'px'; };
  const lines = String(text).split('\n');
  measureCtx.font = font; setLS(measureCtx);
  const widths = lines.map(l => Math.max(0, measureCtx.measureText(l).width));
  if ('letterSpacing' in measureCtx) measureCtx.letterSpacing = '0px';
  const tw = Math.max(1, ...widths);
  const pad = size * 0.1, slant = fx.it ? 0.2 : 0, extra = slant * size;
  const lh = (fx.lh || 1.2) * size, asc = size * 1.0;
  const w = tw + pad * 2 + extra;
  const h = asc + (lines.length - 1) * lh + size * 0.3;
  const K = Math.max(0.5, Math.min(8, 4000 / w, 4000 / h));
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * K); c.height = Math.ceil(h * K);
  const ctx = c.getContext('2d');
  ctx.scale(K, K);
  ctx.font = font; setLS(ctx);
  const rtl = isHebrew(text);
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const align = fx.align || (rtl ? 'r' : 'l');
  const x0s = widths.map(lw => align === 'c' ? pad + (tw - lw) / 2 : align === 'r' ? pad + tw - lw : pad);
  if (fx.hl) {           // marker behind the words
    ctx.fillStyle = fx.hl;
    lines.forEach((l, i) => { if (widths[i]) ctx.fillRect(x0s[i] - pad * 0.6, asc + i * lh - size * 0.9, widths[i] + pad * 1.2 + extra, size * 1.15); });
  }
  const th = Math.max(0.5, size * 0.065);
  lines.forEach((line, i) => {
    const by = asc + i * lh;
    ctx.save();
    ctx.translate(x0s[i], by);
    if (slant) ctx.transform(1, 0, -slant, 1, 0, 0);      // italic: lean the letters to the right
    ctx.fillStyle = color;
    ctx.fillText(line, 0, 0);
    ctx.restore();
    ctx.fillStyle = color;
    if (fx.u && widths[i]) ctx.fillRect(x0s[i], by + size * 0.11, widths[i], th);
    if (fx.st && widths[i]) ctx.fillRect(x0s[i], by - size * 0.3, widths[i] + extra * 0.4, th);
  });
  const out = { canvas: c, w, h, asc, pad, padL: pad, padR: pad + extra, key };
  textImgCache.set(key, out);
  if (textImgCache.size > 300) textImgCache.delete(textImgCache.keys().next().value);
  return out;
}
const fxOf = (o) => ({ it: o.it, u: o.u, st: o.st, hl: o.hl, align: o.align, lh: o.lh, ls: o.ls });
const ovImg = (o) => textImage(o.text || ' ', o.size, o.color, o.bold, o.font, fxOf(o));
const ovAngle = (o, R) => o.ang - R + (o.rot || 0);

function pageNumberText(fmt, n, t) {
  if (fmt === 'n/t') return `${n} / ${t}`;
  if (fmt === 'he') return `עמוד ${n} מתוך ${t}`;
  if (fmt === 'dash') return `– ${n} –`;
  return String(n);
}

/* Where an overlay's centre sits on the display. Replaced text is anchored at its start edge. */
function overlayCenter(o, vp, R) {
  const [x, y] = vp.convertToViewportPoint(o.px, o.py);
  const img = ovImg(o);
  const a = ovAngle(o, R) * Math.PI / 180, s = vp.scale;
  // horizontal: the point is the start/end edge of the letters; vertical: the point is on the first baseline
  const hx = o.anchor === 'l' ? (img.w / 2 - img.padL) * s : o.anchor === 'r' ? -(img.w / 2 - img.padR) * s : 0;
  const vy = o.vb === 'base' ? (img.h / 2 - img.asc) * s : 0;
  return [x + hx * Math.cos(a) + vy * Math.sin(a), y - hx * Math.sin(a) + vy * Math.cos(a)];
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
    out.push({ img: ovImg(o), cx, cy, a: ovAngle(o, R), op: o.op ?? 1 });
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

/* ---------- Views and bottom sheets ---------- */
let view = 'pages';
let selecting = false;
const edActive = () => view === 'edit';
function showView(v) {
  view = v;
  $('pagesView').hidden = v !== 'pages';
  $('editView').hidden = v !== 'edit';
  document.querySelectorAll('.tab').forEach(t => t.dataset.tab === v ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current'));
  positionFmtBar();
}
function closeSheets() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }
function openSheet(id) { closeSheets(); $(id).showModal(); }
document.querySelectorAll('.sheet-dlg').forEach(d => {
  // tap on the dimmed backdrop or on a close button closes the sheet
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});
const copyCanvas = (c) => { const k = document.createElement('canvas'); k.width = c.width; k.height = c.height; k.getContext('2d').drawImage(c, 0, 0); return k; };

/* ---------- Page grid ---------- */
let renderSeq = 0;
const finePointer = window.matchMedia && matchMedia('(pointer: fine)').matches;
function renderGrid() {
  const has = state.pages.length > 0;
  $('home').hidden = has;
  $('app').hidden = !has;
  if (!has) { selecting = false; state.selected.clear(); if (view === 'edit') showView('pages'); }
  const total = state.pages.length;
  const srcCount = new Set(state.pages.map(p => p.src)).size;
  $('docName').textContent = ($('fileName').value || 'מסמך').replace(/\.pdf$/i, '');
  $('docMeta').textContent = `${total} עמודים` + (srcCount > 1 ? ` · ${srcCount} קבצים ממוזגים` : '');
  $('grid').classList.toggle('selecting', selecting);
  $('tabbar').hidden = selecting;
  $('selbar').hidden = !selecting;
  $('selCount').textContent = `${state.selected.size} נבחרו`;
  document.querySelectorAll('[data-needsel]').forEach(b => b.disabled = !state.selected.size);
  const s0 = settings();
  $('wmDot').hidden = !s0.wm.on; $('pnDot').hidden = !s0.pn.on;

  const grid = $('grid');
  const set = s0;
  const seq = ++renderSeq;
  const frag = document.createDocumentFragment();
  state.pages.forEach((p, n) => {
    const src = state.sources[p.src];
    const sel = state.selected.has(p.id);
    const card = document.createElement('div');
    card.className = 'card' + (sel ? ' selected' : '');
    card.draggable = finePointer && !selecting;
    card.dataset.id = p.id;
    card.innerHTML = `
      <button class="thumb" type="button" aria-label="עמוד ${n + 1}"${selecting ? ` aria-pressed="${sel}"` : ''}>
        <span class="ph"></span>
        <span class="check"><svg class="i"><use href="#i-check"/></svg></span>
        <span class="badge">${n + 1}</span>
      </button>` +
      (srcCount > 1 ? `<div class="cap"><i class="srcdot"></i><span>${escapeHtml(src.name.replace(/\.pdf$/i, ''))}</span></div>` : '');
    card.querySelector('.srcdot')?.style.setProperty('background', SRC_COLORS[p.src % SRC_COLORS.length]);
    frag.appendChild(card);
    fillThumb(card, p, n, total, set, seq);
  });
  if (!selecting) {
    const add = document.createElement('div');
    add.className = 'card add';
    add.innerHTML = '<button class="thumb" type="button" id="addCard"><svg class="i"><use href="#i-plus"/></svg>הוספת קובץ</button>';
    frag.appendChild(add);
  }
  grid.replaceChildren(frag);
  if (view === 'edit') renderStrip();
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const THUMB_CSS = 170;
async function fillThumb(card, p, n, total, set, seq) {
  const pg = await getPage(p.src, p.idx);
  const R = totalRot(pg, p);
  const base = pg.getViewport({ scale: 1, rotation: R });
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
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    try { await pg.render({ canvasContext: ctx, viewport: vp }).promise; } catch (e) { console.warn(e); }
    drawRects(ctx, p, vp);
    drawStamps(ctx, stampList(p, pg, vp, n, total, set), scale);
    thumbCache.set(p.id, { key, canvas });
  }
  updateStripItem(p.id);
  if (seq !== renderSeq) return;
  const th = card.querySelector('.thumb');
  const ph = th.querySelector('.ph, canvas');
  if (ph) ph.replaceWith(canvas); else th.prepend(canvas);
}

/* Page strip under the editor */
function renderStrip() {
  const frag = document.createDocumentFragment();
  state.pages.forEach((p, n) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = p.id; b.setAttribute('aria-label', `עמוד ${n + 1}`);
    if (p.id === ed.pid) b.setAttribute('aria-current', 'true');
    b.innerHTML = `<span>${n + 1}</span>`;
    const c = thumbCache.get(p.id)?.canvas;
    if (c) b.prepend(copyCanvas(c));
    frag.appendChild(b);
  });
  $('strip').replaceChildren(frag);
  const cur = $('strip').querySelector('[aria-current="true"]');
  if (cur) $('strip').scrollLeft += (cur.getBoundingClientRect().left + cur.offsetWidth / 2) - ($('strip').getBoundingClientRect().left + $('strip').clientWidth / 2);
}
function updateStripItem(id) {
  if (view !== 'edit') return;
  const b = $('strip').querySelector(`[data-id="${id}"]`), c = thumbCache.get(id)?.canvas;
  if (!b || !c) return;
  b.querySelector('canvas')?.remove();
  b.prepend(copyCanvas(c));
}
$('strip').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openEditor(+b.dataset.id); });

/* Page sheet: everything you can do with one page */
let sheetPid = null;
async function openPageSheet(id) {
  const p = state.pages.find(x => x.id === id); if (!p) return;
  sheetPid = id;
  const n = idxOf(id), src = state.sources[p.src];
  const pg = await getPage(p.src, p.idx);
  const base = pg.getViewport({ scale: 1, rotation: totalRot(pg, p) });
  $('psTitle').textContent = `עמוד ${n + 1} מתוך ${state.pages.length}`;
  $('psMeta').textContent = `${src.name.replace(/\.pdf$/i, '')} · ${paperName(base.width, base.height)}`;
  const c = thumbCache.get(id)?.canvas;
  $('psThumb').replaceChildren(...(c ? [copyCanvas(c)] : []));
  $('pageSheet').querySelector('[data-act="left"]').disabled = n === 0;
  $('pageSheet').querySelector('[data-act="right"]').disabled = n === state.pages.length - 1;
  openSheet('pageSheet');
}
$('pageSheet').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]'); if (!a || a.disabled) return;
  const id = sheetPid, one = new Set([id]);
  $('pageSheet').close();
  switch (a.dataset.act) {
    case 'edit': openEditor(id); break;
    case 'rotl': rotate(one, -90); break;
    case 'rotr': rotate(one, 90); break;
    case 'dup': duplicate(one); break;
    case 'left': move(id, idxOf(id) - 1); break;
    case 'right': move(id, idxOf(id) + 1); break;
    case 'select': startSelecting(id); break;
    case 'del': removePages(one); break;
  }
});
function startSelecting(id) {
  selecting = true; state.selected.clear();
  if (id != null) state.selected.add(id);
  renderGrid();
}
function stopSelecting() { selecting = false; state.selected.clear(); renderGrid(); }

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

/* Tap: page actions (or select while choosing). Long press: start choosing pages. */
let press = null, skipClick = false;
$('grid').addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card:not(.add)'); if (!card || e.button > 0) return;
  clearTimeout(press?.t);
  press = { x: e.clientX, y: e.clientY, t: setTimeout(() => {
    press = null; skipClick = true;
    const id = +card.dataset.id;
    if (selecting) { state.selected.add(id); renderGrid(); } else startSelecting(id);
    try { navigator.vibrate && navigator.vibrate(12); } catch (_) {}
  }, 480) };
});
$('grid').addEventListener('pointermove', (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.t); press = null; }
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => $('grid').addEventListener(t, () => {
  if (press) { clearTimeout(press.t); press = null; }
  // the click that follows a long press is ignored; if the page was redrawn and no click comes, forget it
  if (skipClick) setTimeout(() => { skipClick = false; }, 60);
}));
$('grid').addEventListener('contextmenu', (e) => { if (e.target.closest('.card')) e.preventDefault(); });
$('grid').addEventListener('click', (e) => {
  if (skipClick) { skipClick = false; return; }
  if (e.target.closest('#addCard')) { $('fileInput').click(); return; }
  const card = e.target.closest('.card'); if (!card) return;
  const id = +card.dataset.id;
  if (selecting) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    renderGrid();
  } else openPageSheet(id);
});
$('grid').addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card:not(.add)');
  if (card && !selecting) { closeSheets(); openEditor(+card.dataset.id); }
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

/* ---------- Top bar, tab bar, selection bar ---------- */
$('pickBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('sampleBtn').onclick = makeSample;
$('undoBtn').onclick = undo;
$('moreBtn').onclick = () => openSheet('moreSheet');
$('addFilesBtn').onclick = () => { closeSheets(); $('fileInput').click(); };
$('startSelBtn').onclick = () => { closeSheets(); if (edActive()) leaveEditor(); startSelecting(); };
$('clearBtn').onclick = () => {
  closeSheets(); snapshot(); state.pages = []; state.selected.clear(); selecting = false; showView('pages'); renderGrid();
  toast('המסמך נסגר. אפשר להחזיר אותו עם "ביטול פעולה".', 4000);
  $('home').hidden = false;
};
$('tabbar').addEventListener('click', (e) => {
  const t = e.target.closest('.tab'); if (!t) return;
  const k = t.dataset.tab;
  if (k === 'pages') { if (edActive()) leaveEditor(); }
  else if (k === 'edit') { if (!edActive()) openEditor(idxOf(ed.pid) >= 0 ? ed.pid : state.pages[0].id); }
  else if (k === 'wm') openSheet('wmSheet');
  else if (k === 'pn') openSheet('pnSheet');
});
$('selDone').onclick = stopSelecting;
$('selAllBtn').onclick = () => {
  if (state.selected.size === state.pages.length) state.selected.clear(); else state.pages.forEach(p => state.selected.add(p.id));
  renderGrid();
};
$('rotRBtn').onclick = () => rotate(new Set(state.selected), 90);
$('dupBtn').onclick = () => duplicate(new Set(state.selected));
$('delBtn').onclick = () => removePages(new Set(state.selected));
$('fileName').addEventListener('input', () => { $('fileName').dataset.auto = 'no'; $('docName').textContent = $('fileName').value.replace(/\.pdf$/i, ''); });
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
  if (e.key === 'Escape' && selecting && !document.querySelector('dialog[open]')) stopSelecting();
});

/* Settings panel */
let settingsTimer;
function onSettings() {
  $('wmOpacityVal').textContent = $('wmOpacity').value + '%';
  $('wmGroup').classList.toggle('off', !$('wmOn').checked);
  $('pnGroup').classList.toggle('off', !$('pnOn').checked);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(renderGrid, 180);
}
['wmOn', 'wmText', 'wmSize', 'wmColor', 'wmOpacity', 'wmAngle', 'pnOn', 'pnFmt', 'pnPos', 'pnSize', 'pnStart']
  .forEach(id => { $(id).addEventListener('input', onSettings); $(id).addEventListener('change', onSettings); });

/* ---------- Export ---------- */
async function buildPdf(pages) {
  await ensureFontsFor(pages);
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
$('downloadBtn').onclick = () => {
  if (!state.pages.length) return;
  const k = state.selected.size;
  $('dlAllLabel').textContent = `הורדת המסמך (${state.pages.length} עמודים)`;
  $('dlSelBtn').hidden = !k;
  $('dlSelLabel').textContent = k === 1 ? 'הורדת העמוד שנבחר בלבד' : `הורדת ${k} העמודים שנבחרו`;
  openSheet('dlSheet');
};
$('dlAllBtn').onclick = () => { closeSheets(); exportPages(state.pages, outName()); };
const exportSelected = () => {
  const pages = state.pages.filter(p => state.selected.has(p.id));
  if (pages.length) { closeSheets(); exportPages(pages, outName('-עמודים-נבחרים')); }
};
$('dlSelBtn').onclick = exportSelected;
$('extractBtn').onclick = exportSelected;

/* ---------- Page editor: new text, edit existing text, erase area ---------- */
const ed = { pid: null, selId: null, selRect: null, vp: null, pg: null, base: null, R: 0, scale: 1, fit: 1, zoom: 1, renderTok: 0, canvas: null, drag: null, draw: null, tap: null, pinch: null, mode: 'text', items: [] };
const edPage = () => state.pages.find(p => p.id === ed.pid);
const edSel = () => edPage()?.overlays.find(o => o.id === ed.selId);
const HINTS = {
  text: 'כתבו טקסט בשדה למעלה ולחצו על העמוד כדי להוסיף אותו. גוררים טקסט כדי להזיז אותו.',
  edit: 'לחצו על מילה מסומנת כדי לשנות אותה, או הפעילו "שורה שלמה" כדי לשנות את כל השורה. סל האשפה בסרגל מחזיר את המקור.',
  erase: 'גררו מלבן על האזור שרוצים למחוק. הכיסוי מקבל את צבע הרקע של הדף. שימו לב: הטקסט המקורי נשאר בתוך הקובץ מתחת לכיסוי, ולכן זה לא מתאים להסתרת מידע רגיש.',
};

async function openEditor(id) {
  closeSheets();
  if (selecting) { selecting = false; state.selected.clear(); }
  ed.pid = id; ed.selId = null; ed.selRect = null; cancelGestures(); ed.pinch = null; pointers.clear();
  showView('edit');
  renderGrid();
  await drawEditor();
}
function setMode(m) {
  ed.mode = m; ed.selId = null; ed.selRect = null;
  document.querySelectorAll('#edModes .mode').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('stage').dataset.mode = m;
  $('edTextTools').classList.toggle('off', m === 'erase');
  $('lineMode').hidden = m !== 'edit';
  drawOverlays();
}
async function drawEditor() {
  const p = edPage(); if (!p) return;
  const n = idxOf(p.id);
  $('edTitle').textContent = `עמוד ${n + 1} מתוך ${state.pages.length}`;
  $('edPrev').disabled = n <= 0; $('edNext').disabled = n >= state.pages.length - 1;
  const pg = await getPage(p.src, p.idx);
  const R = totalRot(pg, p);
  // The page's own text, so it can be clicked and replaced
  let items = [];
  try {
    const tc = await pg.getTextContent();
    ed.styles = tc.styles || {};
    items = tc.items.map((it, i) => ({ ...it, i })).filter(it =>
      it.str && it.str.trim() && Math.abs(it.transform[1]) < 0.01 && Math.abs(it.transform[2]) < 0.01 && it.transform[0] > 0 && it.width > 0);
  } catch (e) { console.warn(e); }
  if (ed.pid !== p.id) return;
  const pageChanged = ed.pg !== pg || ed.R !== R;
  Object.assign(ed, { pg, R, items, base: pg.getViewport({ scale: 1, rotation: R }) });
  computeFit();
  if (pageChanged) { $('stage').querySelector('canvas')?.remove(); ed.canvas = null; }
  layoutEditor();
  ensureFontsFor([p]).then(() => { if (ed.pid === p.id) drawOverlays(); });
  await renderBitmap();
}
function computeFit() {
  const body = $('edBody');
  const phone = window.innerWidth <= 600;
  const availW = Math.max(200, Math.min(900, (body.clientWidth || window.innerWidth) - (phone ? 16 : 32)));
  const availH = Math.max(280, (body.clientHeight || window.innerHeight - 300) - 32);
  // On a phone the page fills the screen width (scroll down for the rest); elsewhere the whole page fits
  ed.fit = phone ? availW / ed.base.width : Math.min(availW / ed.base.width, availH / ed.base.height, 2.5);
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
function textColorInside(v, bgHex) {
  if (!ed.canvas) return '#000000';
  const bg = bgHex ? [1, 3, 5].map(i => parseInt(bgHex.slice(i, i + 2), 16)) : [255, 255, 255];
  const ctx = ed.canvas.getContext('2d', { willReadFrequently: true });
  const k = ed.canvas.width / ed.vp.width;
  const x = Math.max(0, Math.round(v.left * k)), y = Math.max(0, Math.round(v.top * k));
  const w = Math.max(1, Math.min(ed.canvas.width - x, Math.round(v.width * k))), h = Math.max(1, Math.min(ed.canvas.height - y, Math.round(v.height * k)));
  const d = ctx.getImageData(x, y, w, h).data;
  // the letters are the pixels that stand out most from the background (works for dark text on light pages and light text on dark ones)
  let best = -1, col = null;
  for (let i = 0; i < d.length; i += 8) {
    const dist = (d[i] - bg[0]) ** 2 + (d[i + 1] - bg[1]) ** 2 + (d[i + 2] - bg[2]) ** 2;
    if (dist > best) { best = dist; col = [d[i], d[i + 1], d[i + 2]]; }
  }
  if (!col || best < 900) col = (bg[0] + bg[1] + bg[2]) / 3 > 128 ? [0, 0, 0] : [255, 255, 255];
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
    const used = usedItems(p);
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
    positionOv(el, o);
    el.style.transform = `translate(-50%, -50%) rotate(${-ovAngle(o, ed.R)}deg)`;
    const img = ovImg(o);
    const cv = document.createElement('canvas');
    cv.width = img.canvas.width; cv.height = img.canvas.height;
    cv.getContext('2d').drawImage(img.canvas, 0, 0);
    cv.style.width = img.w * ed.scale + 'px'; cv.style.height = img.h * ed.scale + 'px';
    cv.style.opacity = o.op ?? 1;
    el.appendChild(cv);
    if (!o.text) el.classList.add('empty');
    stage.appendChild(el);
  }
  syncFmtBar();
  $('edHint').textContent = ed.selId
    ? 'הטקסט המסומן מתעדכן לפי השדה למעלה וסרגל העיצוב. גררו כדי להזיז. לחיצה על אזור ריק מבטלת את הסימון.'
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
  $('edText').value = o.text;
  growText();
  syncFmtBar();
}
function removeOverlay(p, id) {
  const o = p.overlays.find(x => x.id === id);
  p.overlays = p.overlays.filter(x => x.id !== id);
  if (o && o.rectId) p.rects = (p.rects || []).filter(r => r.id !== o.rectId);
}

/* Which bundled font looks most like the font this text was written in */
function guessFont(it) {
  let name = '', fobj = null;
  try { if (ed.pg.commonObjs.has(it.fontName)) fobj = ed.pg.commonObjs.get(it.fontName); } catch (_) {}
  name = (fobj && (fobj.name || '')) + ' ' + ((ed.styles[it.fontName] || {}).fontFamily || '');
  const n = name.toLowerCase().replace(/^[a-z]{6}\+/, '');
  const bold = !!(fobj && (fobj.bold || fobj.black)) || /bold|black|heavy|demi/.test(n);
  let font = 'arimo';
  if (/david/.test(n)) font = 'david';
  else if (/courier|cousine|mono/.test(n)) font = 'cousine';
  else if (/alef/.test(n)) font = 'alef';
  else if (/assistant/.test(n)) font = 'assistant';
  else if (/rubik/.test(n)) font = 'rubik';
  else if (/opensans|open sans/.test(n)) font = 'opensans';
  else if (/notoserif/.test(n)) font = 'notoserif';
  else if (/notosans/.test(n)) font = 'notosans';
  else if (/varela/.test(n)) font = 'varela';
  else if (/plex/.test(n)) font = 'plex';
  else if (/frank|ruehl|ruhl/.test(n)) font = 'frank';
  else if (/miriam/.test(n)) font = 'miriam';
  else if (/times|tinos|roman|narkis|georgia|garamond|cambria|serif(?!.*sans)/.test(n) && !/sans/.test(n)) font = 'tinos';
  else if (/heebo|segoe|calibri/.test(n)) font = 'heebo';
  ensureFont(font).then(() => { if (edActive()) drawOverlays(); });
  return { font, bold };
}
const usedItems = (p) => new Set(p.overlays.flatMap(o => o.srcItems || (o.srcItem != null ? [o.srcItem] : [])));
/* The words around a clicked word that form one line (same baseline and size, close together) */
function lineItems(p, it) {
  const h = itemBox(it).h, used = usedItems(p);
  const same = ed.items.filter(x => !used.has(x.i) && Math.abs(x.transform[5] - it.transform[5]) < h * 0.35 && Math.abs(itemBox(x).h - h) < h * 0.45)
    .sort((a, b) => a.transform[4] - b.transform[4]);
  let i = same.findIndex(x => x.i === it.i); if (i < 0) return [it];
  let lo = i, hi = i;
  const gap = (a, b) => b.transform[4] - (a.transform[4] + a.width);
  while (lo > 0 && gap(same[lo - 1], same[lo]) < h * 1.6) lo--;
  while (hi < same.length - 1 && gap(same[hi], same[hi + 1]) < h * 1.6) hi++;
  return same.slice(lo, hi + 1);
}
function replaceItem(p, it) {
  const its = prefs.lineMode ? lineItems(p, it) : [it];
  snapshot();
  const boxes = its.map(itemBox);
  const box = { x1: Math.min(...boxes.map(b => b.x1)), y1: Math.min(...boxes.map(b => b.y1)), x2: Math.max(...boxes.map(b => b.x2)), y2: Math.max(...boxes.map(b => b.y2)), h: itemBox(it).h };
  const v = toView(box);
  const bg = sampleBg(v);
  const rect = { id: uid++, x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, color: bg, link: true };
  p.rects = p.rects || [];
  p.rects.push(rect);
  // In a Hebrew line, changed text keeps its right edge (the side the line starts from)
  const rtl = its.some(x => isHebrew(x.str)) || ed.items.some(x => Math.abs(x.transform[5] - it.transform[5]) < box.h * 0.3 && isHebrew(x.str));
  // words in reading order, with a space wherever the original had a gap
  const ordered = [...its].sort((a, b) => rtl ? b.transform[4] - a.transform[4] : a.transform[4] - b.transform[4]);
  let text = '';
  ordered.forEach((x, k) => {
    if (k) {
      const prev = ordered[k - 1];
      const g = rtl ? prev.transform[4] - (x.transform[4] + x.width) : x.transform[4] - (prev.transform[4] + prev.width);
      if (g > box.h * 0.12 && !/\s$/.test(text) && !/^\s/.test(x.str)) text += ' ';
    }
    text += x.str;
  });
  const g = guessFont(it);
  const o = {
    id: uid++, text, size: Math.round(box.h * 10) / 10, color: textColorInside(v, bg), bold: g.bold, font: g.font,
    // anchored at the start edge of the original words, on the original baseline
    px: rtl ? box.x2 - box.h * 0.05 : box.x1 + box.h * 0.05, py: it.transform[5], vb: 'base', ang: 0, anchor: rtl ? 'r' : 'l',
    srcItem: it.i, srcItems: its.map(x => x.i), rectId: rect.id,
  };
  p.overlays.push(o);
  ed.selId = o.id; ed.selRect = null;
  loadFields(o);
  drawOverlays();
  $('edText').focus(); $('edText').select();
}
/* Keep text on a line: replaced text stays on its own baseline, other text snaps to nearby lines */
function snapToLine(o) {
  hideGuide();
  if (!prefs.lock || ((o.ang % 360) + 360) % 360 !== 0 || (o.rot || 0) !== 0 || o.vb !== 'base') return;
  let y = null;
  if (o.srcItem != null) {
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
  snapToLine(ed.drag.o);
  const el = $('stage').querySelector(`.ov[data-id="${ed.drag.o.id}"]`);
  if (el) positionOv(el, ed.drag.o);
  positionFmtBar();
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
  const o = { id: uid++, text, ...styleCopy(defStyle), px, py, ang: ed.R, vb: 'base' };
  // the tap marks the middle of the text; move the anchor down to its first baseline
  const img = ovImg(o), d = img.asc - img.h / 2, th = o.ang * Math.PI / 180;
  o.px += d * Math.sin(th); o.py -= d * Math.cos(th);
  snapToLine(o); hideGuide();
  p.overlays.push(o);
  ed.selId = o.id;
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

/* ---------- Text style: floating toolbar and sheets ---------- */
function loadPrefs() {
  const d = { lock: true, lineMode: false, recent: [] };
  try { return Object.assign(d, JSON.parse(localStorage.getItem('dafdaf.prefs') || '{}')); } catch (_) { return d; }
}
function savePrefs() { try { localStorage.setItem('dafdaf.prefs', JSON.stringify(prefs)); } catch (_) {} }
const prefs = loadPrefs();
const defStyle = { font: 'heebo', size: 18, color: '#1a3fb0', bold: false, it: false, u: false, st: false, hl: '', align: '', lh: 1.2, ls: 0, op: 1, rot: 0 };
const styleCopy = (src) => Object.fromEntries(Object.keys(defStyle).map(k => [k, src[k] ?? defStyle[k]]));
const curStyle = () => edSel() || defStyle;
let fmtOpen = false, styleBurst = false, burstTimer;
/* One undo step per burst of changes (typing, dragging a slider) */
function beginBurst() {
  if (!styleBurst) { snapshot(); styleBurst = true; }
  clearTimeout(burstTimer); burstTimer = setTimeout(() => { styleBurst = false; }, 900);
}
function applyStyle(patch) {
  const o = edSel();
  if (o) { beginBurst(); Object.assign(o, patch); } else Object.assign(defStyle, patch);
  if (patch.font) {
    prefs.recent = [patch.font, ...prefs.recent.filter(k => k !== patch.font)].slice(0, 4); savePrefs();
    ensureFont(patch.font).then(() => { if (edActive()) drawOverlays(); });
  }
  drawOverlays();
}
const fontShort = (k) => (FONTS[k] || FONTS.heebo).label.replace(/\s*\(.*\)\s*$/, '');
function syncFmtBar() {
  const st = curStyle();
  $('fbFontName').textContent = fontShort(st.font || 'heebo');
  if (document.activeElement !== $('fbSize')) $('fbSize').value = Math.round((st.size || 18) * 10) / 10;
  $('fbBold').setAttribute('aria-pressed', String(!!st.bold));
  $('fbItalic').setAttribute('aria-pressed', String(!!st.it));
  $('fbUnder').setAttribute('aria-pressed', String(!!st.u));
  $('fbStrike').setAttribute('aria-pressed', String(!!st.st));
  $('fbSwatch').style.background = st.color || '#000000';
  $('fbSwatch').style.outline = st.hl ? `3px solid ${st.hl}` : '';
  const o = edSel();
  $('fbDelete').hidden = !o;
  if (o) $('fbDelete').title = o.srcItem != null ? 'החזרת הטקסט המקורי' : 'מחיקת הטקסט';
  $('styleToggle').setAttribute('aria-expanded', String(fmtOpen));
  positionFmtBar();
}
/* Above the selected text (or below it when there is no room); docked at the top of the page area otherwise */
function positionFmtBar() {
  const bar = $('fmtBar');
  const show = edActive() && ed.mode !== 'erase' && (!!ed.selId || fmtOpen);
  bar.hidden = !show;
  if (!show) return;
  const view = $('editView').getBoundingClientRect(), body = $('edBody').getBoundingClientRect();
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const minTop = body.top - view.top + 8, maxTop = body.bottom - view.top - bh - 8;
  let top = minTop, left = (view.width - bw) / 2;
  const el = ed.selId && $('stage').querySelector(`.ov[data-id="${ed.selId}"]`);
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.bottom > body.top && r.top < body.bottom) {
      top = r.top - view.top - bh - 14;
      if (top < minTop) top = r.bottom - view.top + 14;
      if (top > maxTop) top = minTop;
      left = r.left + r.width / 2 - view.left - bw / 2;
    }
  }
  bar.style.top = Math.max(minTop, top) + 'px';
  bar.style.left = Math.max(8, Math.min(view.width - bw - 8, left)) + 'px';
}
$('edBody').addEventListener('scroll', positionFmtBar, { passive: true });
$('styleToggle').onclick = () => { fmtOpen = !fmtOpen; syncFmtBar(); };

/* Text field: grows up to a few lines; Enter starts a new line */
function growText() {
  const t = $('edText');
  t.rows = Math.min(4, Math.max(1, t.value.split('\n').length));
}
$('edText').addEventListener('input', () => {
  growText();
  const o = edSel(); if (!o) return;
  beginBurst(); o.text = $('edText').value; drawOverlays();
});

/* Toolbar buttons */
const sizeStep = (s) => s < 10 ? 0.5 : s < 30 ? 1 : 2;
$('fbSizeDn').onclick = () => { const s = curStyle().size; applyStyle({ size: Math.max(4, Math.round((s - sizeStep(s - 0.01)) * 10) / 10) }); };
$('fbSizeUp').onclick = () => { const s = curStyle().size; applyStyle({ size: Math.min(300, Math.round((s + sizeStep(s)) * 10) / 10) }); };
$('fbSize').addEventListener('input', () => { const v = parseFloat($('fbSize').value); if (v >= 4 && v <= 300) applyStyle({ size: v }); });
$('fbSize').addEventListener('change', () => syncFmtBar());
$('fbBold').onclick = () => applyStyle({ bold: !curStyle().bold });
$('fbItalic').onclick = () => applyStyle({ it: !curStyle().it });
$('fbUnder').onclick = () => applyStyle({ u: !curStyle().u });
$('fbStrike').onclick = () => applyStyle({ st: !curStyle().st });
$('fbDelete').onclick = () => {
  const p = edPage(); if (!p || !ed.selId) return;
  snapshot(); removeOverlay(p, ed.selId); ed.selId = null; $('edText').value = ''; growText(); drawOverlays();
};

/* Font sheet: search, recent fonts, each name shown in its own font */
let fontIO = null;
function buildFontList(q) {
  const cur = curStyle().font || 'heebo';
  const norm = (x) => x.toLowerCase();
  const match = (k) => !q || norm(FONTS[k].label + ' ' + FONTS[k].family).includes(norm(q));
  let html = '';
  const add = (title, keys) => {
    if (!keys.length) return;
    html += `<div class="fl-group">${title}</div>` + keys.map(k =>
      `<button type="button" class="fl-row" data-font="${k}" aria-pressed="${k === cur}"><span>${FONTS[k].label}</span><span class="fl-sample">אבג 123</span></button>`).join('');
  };
  if (!q) add('אחרונים', prefs.recent.filter(k => FONTS[k]));
  FONT_GROUPS.forEach((g, i) => add(g, Object.keys(FONTS).filter(k => FONTS[k].g === i && match(k))));
  $('fontList').innerHTML = html || '<p class="hint">לא נמצא גופן בשם הזה.</p>';
  // a font downloads only when its row scrolls into view
  fontIO?.disconnect();
  fontIO = new IntersectionObserver((entries) => entries.forEach(en => {
    if (!en.isIntersecting) return;
    const el = en.target, k = el.dataset.font;
    el.style.fontFamily = fontStack(k); el.style.fontWeight = String(fontWeight(k, false));
    fontIO.unobserve(el);
  }), { root: $('fontList') });
  $('fontList').querySelectorAll('.fl-row').forEach(el => fontIO.observe(el));
}
$('fbFont').onclick = () => { $('fontSearch').value = ''; openSheet('fontSheet'); buildFontList(''); $('fontList').scrollTop = 0; };
$('fontSearch').addEventListener('input', () => buildFontList($('fontSearch').value.trim()));
$('fontList').addEventListener('click', (e) => {
  const b = e.target.closest('.fl-row'); if (!b) return;
  applyStyle({ font: b.dataset.font });
  $('fontSheet').close();
});

/* Colour sheet */
const TEXT_COLORS = ['#000000', '#ffffff', '#374151', '#9ca3af', '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#0f6c72', '#1a3fb0', '#7c3aed', '#d81b60'];
const HL_COLORS = ['', '#fff176', '#c5e1a5', '#b3e5fc', '#f8bbd0', '#ffe0b2', '#e0e0e0'];
function buildSwatches(id, colors, prop, custom) {
  const box = $(id), cur = curStyle()[prop] || '';
  box.replaceChildren();
  for (const col of colors) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swb' + (col ? '' : ' none');
    if (col) b.style.background = col;
    b.setAttribute('aria-label', col || 'ללא מרקר');
    b.setAttribute('aria-pressed', String(cur.toLowerCase() === col));
    b.onclick = () => { applyStyle({ [prop]: col }); buildColorSheet(); };
    box.appendChild(b);
  }
  if (custom) {
    const wrap = document.createElement('label');
    wrap.className = 'swb-custom'; wrap.title = 'צבע אחר';
    const inp = document.createElement('input');
    inp.type = 'color'; inp.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#000000'; inp.setAttribute('aria-label', 'צבע אחר');
    inp.addEventListener('input', () => applyStyle({ [prop]: inp.value }));
    wrap.appendChild(inp); box.appendChild(wrap);
  }
}
function buildColorSheet() { buildSwatches('txtSwatches', TEXT_COLORS, 'color', true); buildSwatches('hlSwatches', HL_COLORS, 'hl', true); }
$('fbColor').onclick = () => { openSheet('colorSheet'); buildColorSheet(); };

/* Advanced sheet: alignment, spacing, transparency, rotation, line lock */
function syncStyleSheet() {
  const st = curStyle();
  const al = st.align || (isHebrew(st.text || $('edText').value || 'א') ? 'r' : 'l');
  $('alignSeg').querySelectorAll('[data-align]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.align === al)));
  $('lhRange').value = st.lh ?? 1.2; $('lhVal').textContent = (+(st.lh ?? 1.2)).toFixed(2);
  $('lsRange').value = st.ls ?? 0; $('lsVal').textContent = (+(st.ls ?? 0)).toFixed(2);
  $('opRange').value = Math.round((st.op ?? 1) * 100); $('opVal').textContent = Math.round((st.op ?? 1) * 100) + '%';
  $('rotRange').value = st.rot ?? 0; $('rotVal').textContent = (st.rot ?? 0) + '°';
  $('lockLine').checked = prefs.lock;
}
$('fbMore').onclick = () => { openSheet('styleSheet'); syncStyleSheet(); };
$('alignSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-align]'); if (b) { applyStyle({ align: b.dataset.align }); syncStyleSheet(); } });
$('lhRange').addEventListener('input', () => { applyStyle({ lh: +$('lhRange').value }); syncStyleSheet(); });
$('lsRange').addEventListener('input', () => { applyStyle({ ls: +$('lsRange').value }); syncStyleSheet(); });
$('opRange').addEventListener('input', () => { applyStyle({ op: +$('opRange').value / 100 }); syncStyleSheet(); });
$('rotRange').addEventListener('input', () => { applyStyle({ rot: +$('rotRange').value }); syncStyleSheet(); });
$('rotReset').onclick = () => { applyStyle({ rot: 0 }); syncStyleSheet(); };
$('lockLine').addEventListener('change', () => { prefs.lock = $('lockLine').checked; savePrefs(); });

/* Edit mode: word or whole line */
$('lineMode').onclick = () => { prefs.lineMode = !prefs.lineMode; savePrefs(); $('lineMode').setAttribute('aria-pressed', String(prefs.lineMode)); };
$('lineMode').setAttribute('aria-pressed', String(prefs.lineMode));

document.querySelectorAll('#edModes .mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.addEventListener('keydown', (e) => {
  if (!edActive()) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && (ed.selId || ed.selRect)) {
    e.preventDefault(); snapshot();
    const p = edPage();
    if (ed.selId) removeOverlay(p, ed.selId); else p.rects = (p.rects || []).filter(r => r.id !== ed.selRect);
    ed.selId = null; ed.selRect = null; drawOverlays();
  }
});
function leaveEditor() { cancelGestures(); hideGuide(); showView('pages'); renderGrid(); }
$('edPrev').onclick = () => { const n = idxOf(ed.pid); if (n > 0) openEditor(state.pages[n - 1].id); };
$('edNext').onclick = () => { const n = idxOf(ed.pid); if (n < state.pages.length - 1) openEditor(state.pages[n + 1].id); };
window.addEventListener('resize', () => { if (edActive() && ed.pg) { clearTimeout(ed.rt); ed.rt = setTimeout(() => { computeFit(); layoutEditor(); scheduleRender(); }, 200); } });

ensureFont('heebo').then(() => { if (state.pages.length) renderGrid(); });
onSettings();
renderGrid();
})();
