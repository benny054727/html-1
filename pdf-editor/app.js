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
  fields: {},    // source index -> Map(page index -> [form fields])
  forms: {},     // source index -> { field name: value }
};
let uid = 1;
const persisted = new Set();   // keys of files and pictures already in device storage
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
  if (edActive()) { ed.inline = null; $('stage').querySelector('.ov.inline')?.remove(); if (!edPage()) leaveEditor(); else { ed.selId = null; drawEditor(); } }
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
  if (pages.some(p => pageFields(p).length)) keys.add('arimo');
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
  const out = { canvas: c, w, h, asc, pad, padL: pad, padR: pad + extra, key, lines: lines.map((l, i) => ({ x0: x0s[i], w: widths[i], by: asc + i * lh })) };
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

/* ---------- Form fields ---------- */
const FORMS_OFF = pdfjsLib.AnnotationMode ? pdfjsLib.AnnotationMode.ENABLE_FORMS : 2;   // pages are drawn without the form layer
async function loadFormFields(src) {
  const s = state.sources[src], byPage = new Map();
  let count = 0;
  const names = new Set();
  for (let i = 0; i < s.pdf.numPages; i++) {
    let annots = [];
    try { annots = await (await s.pdf.getPage(i + 1)).getAnnotations({ intent: 'display' }); } catch (_) {}
    const list = annots.filter(a => a.annotationType === 20 && a.fieldName && !a.hidden && !a.pushButton &&
      (a.fieldType === 'Tx' || a.fieldType === 'Ch' || (a.fieldType === 'Btn' && (a.checkBox || a.radioButton))))
      .map(a => ({
        name: a.fieldName, type: a.fieldType === 'Tx' ? 'text' : a.fieldType === 'Ch' ? 'choice' : a.checkBox ? 'check' : 'radio',
        rect: a.rect, ro: !!a.readOnly, multi: !!a.multiLine, maxLen: a.maxLen || 0, align: a.textAlignment || 0,
        size: (a.defaultAppearanceData && a.defaultAppearanceData.fontSize) || 0,
        on: a.exportValue || a.buttonValue || 'Yes', options: (a.options || []).map(o => ({ v: o.exportValue, t: o.displayValue })),
        initial: a.fieldValue,
      }));
    if (list.length) byPage.set(i, list);
    for (const f of list) {
      names.add(f.name);
      const vals = state.forms[src] || (state.forms[src] = {});
      if (!(f.name in vals)) {
        if (f.type === 'check') vals[f.name] = f.initial != null && f.initial !== 'Off' && f.initial !== '' && (f.initial === f.on || f.initial === true);
        else if (f.type === 'radio') vals[f.name] = f.initial && f.initial !== 'Off' ? String(f.initial) : '';
        else vals[f.name] = Array.isArray(f.initial) ? (f.initial[0] || '') : (f.initial || '');
      }
    }
  }
  state.fields[src] = byPage;
  if (names.size) { await ensureFont('arimo'); thumbCache.clear(); }
  count = names.size;
  return count;
}
const pageFields = (p) => (state.fields[p.src] && state.fields[p.src].get(p.idx)) || [];
const fieldVal = (p, f) => (state.forms[p.src] || {})[f.name];
const fieldKey = (p) => pageFields(p).map(f => fieldVal(p, f));
function fieldSize(f, h) {
  const auto = f.multi ? 10 : Math.max(6, Math.min(12, h * 0.62));
  return f.size ? Math.min(f.size, f.multi ? 12 : Math.max(6, h * 0.62), 14) : auto;
}
/* Wrap text to a width (in points) for multi-line fields */
function wrapText(text, size, fontKey, width) {
  measureCtx.font = `${fontWeight(fontKey, false)} ${size}px ${fontStack(fontKey)}`;
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const tryLine = line ? line + ' ' + word : word;
      if (line && measureCtx.measureText(tryLine).width > width) { out.push(line); line = word; } else line = tryLine;
    }
    out.push(line);
  }
  return out.join('\n');
}
const markCache = new Map();
function markImage(kind, w, h) {
  const key = kind + w.toFixed(1) + 'x' + h.toFixed(1);
  if (markCache.has(key)) return markCache.get(key);
  const K = 6, c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w * K)); c.height = Math.max(2, Math.round(h * K));
  const x = c.getContext('2d'); x.scale(K, K);
  const m = Math.min(w, h);
  x.fillStyle = x.strokeStyle = '#111827';
  if (kind === 'radio') { x.beginPath(); x.arc(w / 2, h / 2, m * 0.28, 0, Math.PI * 2); x.fill(); }
  else { x.lineWidth = Math.max(1, m * 0.13); x.lineCap = 'round'; x.lineJoin = 'round'; x.beginPath();
    x.moveTo(w / 2 - m * 0.3, h / 2); x.lineTo(w / 2 - m * 0.08, h / 2 + m * 0.24); x.lineTo(w / 2 + m * 0.32, h / 2 - m * 0.26); x.stroke(); }
  const out = { canvas: c, w, h, key: 'mk-' + key };
  markCache.set(key, out);
  return out;
}
/* The filled-in values, drawn on the page (and written as real text in the PDF) */
function fieldStamps(p, vp, R) {
  const out = [];
  for (const f of pageFields(p)) {
    const v = fieldVal(p, f);
    const [x1, y1, x2, y2] = [Math.min(f.rect[0], f.rect[2]), Math.min(f.rect[1], f.rect[3]), Math.max(f.rect[0], f.rect[2]), Math.max(f.rect[1], f.rect[3])];
    const w = x2 - x1, h = y2 - y1;
    if (f.type === 'check' || f.type === 'radio') {
      const on = f.type === 'check' ? !!v : (v && v === f.on);
      if (!on) continue;
      const [cx, cy] = vp.convertToViewportPoint((x1 + x2) / 2, (y1 + y2) / 2);
      out.push({ img: markImage(f.type, w, h), cx, cy, a: -R, op: 1 });
      continue;
    }
    let text = f.type === 'choice' ? ((f.options.find(o => o.v === v) || {}).t ?? v) : v;
    if (!text || !String(text).trim()) continue;
    text = String(text);
    const font = 'arimo';
    let size = fieldSize(f, h);
    if (f.multi) text = wrapText(text, size, font, w - 4);
    else { let img = textImage(text, size, '#111827', false, font); while (img.w - img.padL - img.padR > w - 4 && size > 5) { size -= 0.5; img = textImage(text, size, '#111827', false, font); } }
    const img = textImage(text, size, '#111827', false, font);
    const rtl = isHebrew(text);
    const align = f.align === 1 ? 'c' : f.align === 2 ? 'r' : (rtl ? 'r' : 'l');
    const cxu = align === 'c' ? (x1 + x2) / 2 : align === 'r' ? x2 - 2 + img.padR - img.w / 2 : x1 + 2 - img.padL + img.w / 2;
    const base = f.multi ? y2 - 2 - size * 0.95 : y1 + (h - size * 0.72) / 2;
    const cyu = base + (img.asc - img.h / 2);
    const [cx, cy] = vp.convertToViewportPoint(cxu, cyu);
    out.push({ img, cx, cy, a: -R, op: 1, t: { text, size, color: '#111827', bold: false, font, fx: {} } });
  }
  return out;
}
function removeWidgets(doc, page) {
  const { PDFName, PDFArray } = PDFLib;
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
  if (!annots) return;
  const keep = annots.asArray().filter(ref => {
    const d = doc.context.lookup(ref);
    const sub = d && d.get && d.get(PDFName.of('Subtype'));
    return !(sub && sub.toString() === '/Widget');
  });
  page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
}
/* Editor: fields become real inputs on top of the page */
let fieldTimer;
function setField(p, f, v) {
  (state.forms[p.src] || (state.forms[p.src] = {}))[f.name] = v;
  clearTimeout(fieldTimer); fieldTimer = setTimeout(renderGrid, 400);
}
function drawFields(p) {
  const fields = pageFields(p); if (!fields.length) return;
  const stage = $('stage');
  for (const f of fields) {
    const v = toView({ x1: Math.min(f.rect[0], f.rect[2]), y1: Math.min(f.rect[1], f.rect[3]), x2: Math.max(f.rect[0], f.rect[2]), y2: Math.max(f.rect[1], f.rect[3]) });
    let el;
    const val = fieldVal(p, f);
    if (f.type === 'check' || f.type === 'radio') {
      el = document.createElement('button');
      el.type = 'button'; el.className = 'ff ff-' + f.type;
      const on = f.type === 'check' ? !!val : val === f.on;
      el.setAttribute('aria-pressed', String(on)); el.setAttribute('aria-label', f.name);
      el.textContent = on ? (f.type === 'check' ? '✓' : '●') : '';
      el.onclick = () => {
        if (f.ro) return;
        if (f.type === 'check') setField(p, f, !fieldVal(p, f));
        else setField(p, f, fieldVal(p, f) === f.on ? '' : f.on);
        drawOverlays();
      };
    } else if (f.type === 'choice') {
      el = document.createElement('select'); el.className = 'ff';
      el.appendChild(new Option('', ''));
      for (const o of f.options) el.appendChild(new Option(o.t, o.v));
      el.value = val || '';
      el.onchange = () => setField(p, f, el.value);
    } else {
      el = document.createElement(f.multi ? 'textarea' : 'input'); el.className = 'ff';
      if (!f.multi) el.type = 'text';
      el.value = val || ''; el.dir = 'auto';
      if (f.maxLen) el.maxLength = f.maxLen;
      el.addEventListener('input', () => setField(p, f, el.value));
    }
    el.title = f.name;
    if (f.ro) { el.disabled = true; el.classList.add('ro'); }
    Object.assign(el.style, { left: v.left + 'px', top: v.top + 'px', width: v.width + 'px', height: v.height + 'px',
      fontSize: Math.max(8, fieldSize(f, v.height / ed.scale) * ed.scale) + 'px' });
    stage.appendChild(el);
  }
}

/* All stamps for a page, in display coordinates of viewport vp.
   Each: {img, cx, cy, a (visual degrees, counter-clockwise), op} */
/* Pictures added to pages (signatures, photos, shapes, highlights). The picture data is kept apart
   from the pages so undo steps stay small. */
const assets = new Map();          // key -> data URL
const assetImgs = new Map();       // key -> decoded <img>
function addAsset(dataUrl) { const k = 'a' + Date.now().toString(36) + (uid++); assets.set(k, dataUrl); persisted.add(k); store.put('assets', k, dataUrl); return k; }
function assetImg(k) {
  if (!assetImgs.has(k)) { const im = new Image(); im.src = assets.get(k) || ''; assetImgs.set(k, im); }
  return assetImgs.get(k);
}
function ensureAssets(pages) {
  const list = [];
  for (const p of pages) for (const o of p.objs || []) { const im = assetImg(o.asset); if (!im.complete) list.push(im.decode().catch(() => {})); }
  return Promise.all(list);
}
function stampList(p, pg, vp, n, total, set) {
  const s = vp.scale, R = totalRot(pg, p), out = fieldStamps(p, vp, R);
  for (const o of p.objs || []) {
    const [cx, cy] = vp.convertToViewportPoint(o.cx, o.cy);
    out.push({ img: { canvas: assetImg(o.asset), w: o.w, h: o.h, key: o.asset, src: assets.get(o.asset) }, cx, cy, a: o.ang - R + (o.rot || 0), op: o.op ?? 1 });
  }
  for (const o of p.overlays) {
    if (!o.text.trim()) continue;
    const [cx, cy] = overlayCenter(o, vp, R);
    out.push({ img: ovImg(o), cx, cy, a: ovAngle(o, R), op: o.op ?? 1, t: { text: o.text, size: o.size, color: o.color, bold: o.bold, font: o.font, fx: fxOf(o) } });
  }
  if (set.wm.on && set.wm.text.trim()) {
    out.push({ img: textImage(set.wm.text, set.wm.size, set.wm.color, true), cx: vp.width / 2, cy: vp.height / 2, a: set.wm.angle, op: set.wm.opacity, t: { text: set.wm.text, size: set.wm.size, color: set.wm.color, bold: true, font: 'heebo', fx: {} } });
  }
  if (set.pn.on) {
    const pnText = pageNumberText(set.pn.fmt, n + set.pn.start, total + set.pn.start - 1);
    const img = textImage(pnText, set.pn.size, '#333333', false);
    const m = 28 * s, iw = img.w * s;
    let cx = vp.width / 2, cy = vp.height - m;
    if (set.pn.pos === 'br') cx = vp.width - m - iw / 2;
    if (set.pn.pos === 'bl') cx = m + iw / 2;
    if (set.pn.pos === 'tc') cy = m;
    out.push({ img, cx, cy, a: 0, op: 1, t: { text: pnText, size: set.pn.size, color: '#333333', bold: false, font: 'heebo', fx: {} } });
  }
  return out;
}
function drawStamps(ctx, list, s) {
  for (const st of list) {
    ctx.save();
    ctx.globalAlpha = st.op;
    ctx.translate(st.cx, st.cy);
    ctx.rotate(-st.a * Math.PI / 180);
    if (st.img.canvas instanceof HTMLImageElement && !st.img.canvas.complete) { ctx.restore(); continue; }
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
      const open = await unlockIfNeeded(bytes, f.name);
      if (!open) continue;
      await addBytes(open, f.name);
      added++;
    } catch (e) {
      console.error(e);
      const msg = e && e.name === 'PasswordException' ? `לא הצלחתי לפתוח את "${f.name}" עם הסיסמה הזו.` : `לא הצלחתי לפתוח את "${f.name}". ייתכן שהקובץ פגום.`;
      toast(msg, 5000);
    }
  }
  if (added) { history.push(before); $('undoBtn').disabled = false; maybeTour(); }
  busy(false);
  renderGrid();
}
function openPdf(bytes) {
  return pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,          // never compile code from inside a PDF
    enableXfa: false,
    cMapUrl: 'vendor/cmaps/', cMapPacked: true,
    standardFontDataUrl: 'vendor/standard_fonts/',
  }).promise;
}
async function addSource(bytes, name) {
  const pdf = await openPdf(bytes);
  const src = state.sources.length;
  const key = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  state.sources.push({ name, bytes, pdf, cache: new Map(), key });
  persisted.add(key); store.put('files', key, bytes);
  return src;
}
/* A blank page the same size and direction as the page it follows */
async function insertBlank(afterId) {
  const ref = state.pages.find(p => p.id === afterId);
  let w = 595.28, h = 841.89;
  if (ref) { const pg = await getPage(ref.src, ref.idx); const v = pg.getViewport({ scale: 1, rotation: totalRot(pg, ref) }); w = v.width; h = v.height; }
  const doc = await PDFDocument.create(); doc.addPage([w, h]);
  const src = await addSource(await doc.save(), 'עמוד ריק');
  snapshot();
  const page = { id: uid++, src, idx: 0, rot: 0, overlays: [], rects: [], objs: [] };
  state.pages.splice(ref ? idxOf(afterId) + 1 : state.pages.length, 0, page);
  renderGrid();
  toast('נוסף עמוד ריק');
  return page;
}
async function addBytes(bytes, name) {
  const s0 = state.pages.length > 0;
  if (!s0 && pendingSession) await forgetSession();   // a new document replaces the saved one
  const src = await addSource(bytes, name), pdf = state.sources[src].pdf;
  for (let i = 0; i < pdf.numPages; i++) state.pages.push({ id: uid++, src, idx: i, rot: 0, overlays: [], rects: [], objs: [] });
  const nFields = await loadFormFields(src);
  if (nFields) setTimeout(() => toast(`נמצא טופס עם ${nFields} שדות. אפשר למלא אותם במסך העריכה.`, 4500), 400);
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
  maybeTour();
}

/* ---------- Views and bottom sheets ---------- */
let view = 'pages';
let selecting = false;
const edActive = () => view === 'edit';
function showView(v) {
  const was = view;
  view = v;
  $('pagesView').hidden = v !== 'pages';
  $('editView').hidden = v !== 'edit';
  document.querySelectorAll('.tab').forEach(t => t.dataset.tab === v ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current'));
  positionFmtBar();
  if (v === 'edit' && was !== 'edit') pushLayer('edit');
  if (v !== 'edit' && was === 'edit') popLayer('edit');
}

/* ---------- The phone's back button ----------
   Each layer the user opens (the editor, a sheet, choosing pages, the tour) adds a step to the
   browser history, so "back" closes the top layer instead of leaving the app. When a layer is
   closed on screen, its history step is removed again. */
const nav = { stack: [], ignore: 0, closing: false };
function pushLayer(name) {
  nav.stack.push(name);
  try { window.history.pushState({ mypdf: nav.stack.length }, ''); } catch (_) {}
}
function popLayer(name) {
  if (nav.closing) return;
  const i = nav.stack.lastIndexOf(name); if (i < 0) return;
  nav.stack.splice(i, 1);
  nav.ignore++;
  window.history.back();
}
function closeLayer(top) {
  if (top === 'sheet') {
    const open = [...document.querySelectorAll('dialog[open]')];
    open.forEach(d => { d.dataset.navClosed = '1'; d.close(); });
    return open.length > 0;
  }
  if (top === 'edit') { if (!edActive()) return false; leaveEditor(); return true; }
  if (top === 'select') { if (!selecting) return false; stopSelecting(); return true; }
  if (top === 'tour') { if (tourStep < 0) return false; endTour(); return true; }
  return false;
}
window.addEventListener('popstate', () => {
  if (nav.ignore > 0) { nav.ignore--; return; }
  const top = nav.stack.pop(); if (!top) return;
  nav.closing = true;
  let done = false;
  try { done = closeLayer(top); } finally { nav.closing = false; }
  // that layer was already gone (closed another way): use this back press for the next one
  if (!done && nav.stack.length) window.history.back();
});
function closeSheets() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }
function openSheet(id) { closeSheets(); $(id).showModal(); pushLayer('sheet'); }
document.querySelectorAll('dialog').forEach(d => d.addEventListener('close', () => {
  if (d.dataset.navClosed) { delete d.dataset.navClosed; return; }   // closed by the back button
  popLayer('sheet');
}));
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
  $('docMeta').textContent = pagesText(total) + (srcCount > 1 ? ` · ${srcCount} קבצים ממוזגים` : '');
  showSaveState();
  $('grid').classList.toggle('selecting', selecting);
  $('tabbar').hidden = selecting;
  $('selbar').hidden = !selecting;
  $('selCount').textContent = `${state.selected.size} נבחרו`;
  document.querySelectorAll('[data-needsel]').forEach(b => b.disabled = !state.selected.size);
  const s0 = settings();
  $('toolsDot').hidden = !(s0.wm.on || s0.pn.on);

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
  const key = JSON.stringify([R, p.crop || 0, fieldKey(p), p.overlays, p.rects || [], (p.objs || []).map(o => [o.asset, o.cx, o.cy, o.w, o.h, o.rot, o.op]), set.wm, set.pn.on ? [set.pn, n, total] : 0]);
  await ensureAssets([p]);
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
    try { await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: FORMS_OFF }).promise; } catch (e) { console.warn(e); }
    drawRects(ctx, p, vp);
    drawStamps(ctx, stampList(p, pg, vp, n, total, set), scale);
    if (p.crop) canvas = cropCanvas(canvas, vp, p.crop);
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
    case 'blank': insertBlank(id); break;
    case 'crop': openCrop(id); break;
  }
});
function startSelecting(id) {
  if (!selecting) pushLayer('select');
  selecting = true; state.selected.clear();
  if (id != null) state.selected.add(id);
  renderGrid();
}
function stopSelecting() { if (selecting) popLayer('select'); selecting = false; state.selected.clear(); renderGrid(); }

/* ---------- Page actions ---------- */
const pagesText = (n) => n === 1 ? 'עמוד אחד' : `${n} עמודים`;
const idxOf = (id) => state.pages.findIndex(p => p.id === id);
function cloneWithNewIds(p) {
  const map = new Map();
  const rects = (p.rects || []).map(r => { const id = uid++; map.set(r.id, id); return { ...r, id }; });
  return { ...p, id: uid++, rects, objs: (p.objs || []).map(o => ({ ...o, id: uid++ })), overlays: p.overlays.map(o => ({ ...o, id: uid++, rectId: o.rectId ? map.get(o.rectId) : undefined })) };
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
  else if (k === 'insert') openSheet('insertSheet');
  else if (k === 'tools') openTools();
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
  if (e.key === 'Escape' && typeof ed !== 'undefined' && ed.inline && !document.querySelector('dialog[open]')) { finishInline(); }
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
/* ---------- Real text in the exported PDF ----------
   Text is written as real PDF text with the font embedded (only the letters used), so it can be
   selected, copied and searched, and stays sharp at any zoom. Hebrew is put in visual order here
   because PDF text runs left to right. If a font or a character is not available, that text falls
   back to a picture, exactly as it looks in the editor. */
let fontkitReady = null;
function loadFontkit() {
  return fontkitReady || (fontkitReady = new Promise((res) => {
    if (window.fontkit) return res(window.fontkit);
    const sc = document.createElement('script');
    sc.src = 'vendor/fontkit.umd.min.js';
    sc.onload = () => res(window.fontkit || null); sc.onerror = () => res(null);
    document.head.appendChild(sc);
  }));
}
const HEB_CH = /[֐-׿יִ-ﭏ₪]/;
const HEB_MARK = /[֑-ׇ]/;
const LATIN_CH = /[ -~ -ÿ -⁯€™−]/;
const subsetOf = (ch) => HEB_CH.test(ch) ? 'hebrew' : 'latin';
/* Bidi for one line: runs in visual (left-to-right) order. Inside a Hebrew run the letters stay in
   reading order; the drawing code places them from right to left. */
function bidiRuns(line, rtl) {
  const cl = [];
  for (const ch of line) { if (HEB_MARK.test(ch) && cl.length) cl[cl.length - 1] += ch; else cl.push(ch); }
  // character types, following the Unicode bidi rules that browsers use
  const typ = (c) => { const ch = c[0];
    if (HEB_CH.test(ch) && ch !== '₪') return 'R';
    if (/[0-9]/.test(ch)) return 'EN';
    if (/[A-Za-zÀ-ÿ]/.test(ch)) return 'L';
    if (/[₪$€%°#+\-]/.test(ch)) return 'ET';
    if (/[,.:\/]/.test(ch)) return 'CS';
    return 'N'; };
  const t = cl.map(typ), n = t.length;
  // currency and percent signs next to a number belong to the number; so do separators inside it (4,500 05/06/2024)
  for (let i = 0; i < n; i++) if (t[i] === 'ET') {
    let j = i; while (j < n && t[j] === 'ET') j++;
    const num = (i > 0 && t[i - 1] === 'EN') || (j < n && t[j] === 'EN');
    for (let k = i; k < j; k++) t[k] = num ? 'EN' : 'N';
    i = j - 1;
  }
  for (let i = 0; i < n; i++) if (t[i] === 'CS') t[i] = (i > 0 && i < n - 1 && t[i - 1] === 'EN' && t[i + 1] === 'EN') ? 'EN' : 'N';
  // spaces and punctuation take the direction around them (numbers count as right-to-left here), else the line's
  const base = rtl ? 'R' : 'L', strong = (x) => x === 'L' ? 'L' : 'R', res = t.slice();
  for (let i = 0; i < n; i++) {
    if (res[i] !== 'N') continue;
    let j = i; while (j < n && t[j] === 'N') j++;
    const before = i > 0 ? strong(res[i - 1]) : base, after = j < n ? strong(t[j]) : base;
    for (let k = i; k < j; k++) res[k] = before === after ? before : base;
    i = j - 1;
  }
  // embedding levels: odd levels read right to left
  const level = (x) => rtl ? (x === 'R' ? 1 : 2) : (x === 'R' ? 1 : 0);
  const runs = [];
  cl.forEach((c, i) => { const lv = level(res[i]), r = runs[runs.length - 1]; if (r && r.lv === lv) r.c.push(c); else runs.push({ lv, c: [c] }); });
  runs.forEach(r => { r.d = r.lv % 2 ? 'R' : 'L'; });
  return rtl ? runs.reverse() : runs;
}
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
function pdfFontFor(doc, fonts, fontKey, bold, subset) {
  const fam = (FONTS[fontKey] || FONTS.heebo).family.toLowerCase().replace(/\s+/g, '-');
  const path = `vendor/fonts/${fam}-${subset}-${fontWeight(fontKey, bold)}-normal.woff`;
  if (!fonts.cache.has(path)) {
    fonts.cache.set(path, fetch(path).then(r => r.ok ? r.arrayBuffer() : null)
      .then(b => b ? doc.embedFont(b, { subset: true }) : null).catch(() => null));
  }
  return fonts.cache.get(path);
}
async function drawRealText(doc, page, st, fonts, ux, uy, th) {
  const t = st.t, fx = t.fx || {}, img = st.img;
  if (!t.text.trim() || fx.ls || !img.lines) return false;
  for (const ch of t.text) if (ch !== '\n' && !HEB_CH.test(ch) && !LATIN_CH.test(ch)) return false;
  const fk = await loadFontkit(); if (!fk) return false;
  if (!fonts.registered) { doc.registerFontkit(fk); fonts.registered = true; }
  const lines = t.text.split('\n'), rtl = isHebrew(t.text), size = t.size;
  const need = new Set([...t.text.replace(/\n/g, '')].map(subsetOf));
  const f = {};
  for (const sub of need) { f[sub] = await pdfFontFor(doc, fonts, t.font, t.bold, sub); if (!f[sub]) return false; }
  // measure every piece: Hebrew runs letter by letter, numbers and English in pieces of one font file
  const plan = [];
  try {
    for (let i = 0; i < lines.length; i++) {
      const runs = bidiRuns(lines[i], rtl).map(r => {
        if (r.d === 'R') {
          const cls = r.c.map(c => { const g = MIRROR[c] || c, sub = subsetOf(c[0]); return { s: g, sub, w: f[sub].widthOfTextAtSize(g, size) }; });
          return { d: 'R', cls, w: cls.reduce((a, c) => a + c.w, 0) };
        }
        const segs = [];
        for (const ch of r.c.join('')) { const sub = subsetOf(ch), last = segs[segs.length - 1]; if (last && last.sub === sub) last.s += ch; else segs.push({ sub, s: ch }); }
        segs.forEach(sg => { sg.w = f[sg.sub].widthOfTextAtSize(sg.s, size); });
        return { d: 'L', segs, w: segs.reduce((a, sg) => a + sg.w, 0) };
      });
      plan.push(runs);
    }
  } catch (_) { return false; }
  const cos = Math.cos(th), sin = Math.sin(th), deg = th * 180 / Math.PI;
  // a point inside the editor's picture of this text -> page coordinates
  const at = (lx, ly) => { const dx = lx - img.w / 2, dy = img.h / 2 - ly; return [ux + dx * cos - dy * sin, uy + dx * sin + dy * cos]; };
  const color = hexRgb(t.color), op = st.op, extra = img.padR - img.padL, lw = Math.max(0.5, size * 0.065);
  const bar = (lx, ly, w, h, col) => { const [x, y] = at(lx, ly + h); page.drawRectangle({ x, y, width: w, height: h, rotate: degrees(deg), color: col, opacity: op, borderWidth: 0 }); };
  const put = (s, sub, lx, by) => {
    const [px, py] = at(lx, by);
    page.drawText(s, { x: px, y: py, size, font: f[sub], color, opacity: op, rotate: degrees(deg), ySkew: fx.it ? degrees(11.3) : degrees(0) });
  };
  if (fx.hl) img.lines.forEach(L => { if (L.w) bar(L.x0 - img.pad * 0.6, L.by - size * 0.9, L.w + img.pad * 1.2 + extra, size * 1.15, hexRgb(fx.hl)); });
  img.lines.forEach((L, i) => {
    const runs = plan[i], total = runs.reduce((a, r) => a + r.w, 0);
    const k = total ? L.w / total : 1;
    let x = L.x0;
    for (const r of runs) {
      if (r.d === 'R') {
        // letters in reading order, each one placed further to the left, so copying and searching
        // give the Hebrew words the right way round in every PDF reader
        let right = x + r.w * k;
        for (const c of r.cls) { right -= c.w * k; put(c.s, c.sub, right, L.by); }
      } else {
        let xx = x;
        for (const sg of r.segs) { put(sg.s, sg.sub, xx, L.by); xx += sg.w * k; }
      }
      x += r.w * k;
    }
    if (fx.u && L.w) bar(L.x0, L.by + size * 0.11, L.w, lw, color);
    if (fx.st && L.w) bar(L.x0, L.by - size * 0.3, L.w + extra * 0.4, lw, color);
  });
  return true;
}

/* Secure redaction: the page is redrawn as a picture with the covers burned in, so nothing that was
   under a cover (text, images, hidden layers, links) is left in the file. Text added in the editor
   is written on top afterwards and stays real text. */
async function flatPage(out, p, pg) {
  const [x0, y0, x1, y1] = pg.view, w = x1 - x0, h = y1 - y0;
  const scale = Math.min(200 / 72, 4200 / Math.max(w, h));       // about 200 dpi
  const vp = pg.getViewport({ scale, rotation: 0 });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: FORMS_OFF }).promise;
  drawRects(ctx, p, vp);
  const img = await out.embedJpg(c.toDataURL('image/jpeg', 0.92));
  c.width = c.height = 0;
  const page = out.addPage([w, h]);
  page.setMediaBox(x0, y0, w, h);
  page.drawImage(img, { x: x0, y: y0, width: w, height: h });
  return page;
}

async function buildPdf(pages) {
  await ensureFontsFor(pages);
  const secureAll = $('dlSecure').checked;
  const set = settings();
  const out = await PDFDocument.create();
  const srcDocs = new Map();
  const embedded = new Map();
  const textFonts = { cache: new Map(), registered: false };
  for (let n = 0; n < pages.length; n++) {
    const p = pages[n];
    if (!srcDocs.has(p.src)) srcDocs.set(p.src, await PDFDocument.load(state.sources[p.src].bytes, { ignoreEncryption: true }));
    const pg = await getPage(p.src, p.idx);
    const rects = p.rects || [];
    const flatten = rects.some(r => r.redact) || (secureAll && rects.length);
    let page;
    if (flatten) page = await flatPage(out, p, pg);
    else {
      [page] = await out.copyPages(srcDocs.get(p.src), [p.idx]);
      out.addPage(page);
      if (pageFields(p).length) removeWidgets(out, page);
    }
    const R = totalRot(pg, p);
    page.setRotation(degrees(R));
    if (p.crop) { const c = p.crop; page.setCropBox(c.x1, c.y1, c.x2 - c.x1, c.y2 - c.y1); }
    const vp = pg.getViewport({ scale: 1, rotation: R });
    if (!flatten) for (const r of rects) {
      page.drawRectangle({ x: r.x1, y: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1, color: hexRgb(r.color), borderWidth: 0 });
    }
    for (const st of stampList(p, pg, vp, n, pages.length, set)) {
      if (st.t) {
        const [tx, ty] = vp.convertToPdfPoint(st.cx, st.cy);
        if (await drawRealText(out, page, st, textFonts, tx, ty, (st.a + R) * Math.PI / 180)) continue;
      }
      let img = embedded.get(st.img.key);
      if (!img) {
        const src = st.img.src || st.img.canvas.toDataURL('image/png');
        img = src.startsWith('data:image/jpeg') ? await out.embedJpg(src) : await out.embedPng(src);
        embedded.set(st.img.key, img);
      }
      const [ux, uy] = vp.convertToPdfPoint(st.cx, st.cy);
      const th = (st.a + R) * Math.PI / 180;   // angle in PDF user space (counter-clockwise)
      const hw = st.img.w / 2, hh = st.img.h / 2;
      const x = ux - (hw * Math.cos(th) - hh * Math.sin(th));
      const y = uy - (hw * Math.sin(th) + hh * Math.cos(th));
      page.drawImage(img, { x, y, width: st.img.w, height: st.img.h, rotate: degrees(st.a + R), opacity: st.op });
    }
  }
  out.setProducer('עורך MY PDF');
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
/* ---------- Making files smaller ----------
   light / strong: photos inside the file are re-saved as smaller JPEGs (text stays text);
   max: every page becomes one picture (smallest, but the original text can no longer be selected). */
const COMPRESS = {
  light: { side: 2000, q: 0.78 },
  strong: { side: 1300, q: 0.6 },
  max: { dpi: 110, q: 0.6 },
};
const mb = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;
async function shrinkImages(bytes, opt) {
  const { PDFName, PDFNumber, PDFRawStream } = PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (String(d.get(PDFName.of('Subtype'))) !== '/Image' || d.get(PDFName.of('ImageMask')) || d.get(PDFName.of('SMask')) || d.get(PDFName.of('Mask'))) continue;
    const filter = String(d.get(PDFName.of('Filter')) || '').replace(/[\s\[\]]/g, '');
    const cs = String(d.get(PDFName.of('ColorSpace')) || '');
    if (filter !== '/DCTDecode') continue;                                    // only JPEG photos
    if (cs && cs !== '/DeviceRGB' && cs !== '/DeviceGray') continue;          // leave CMYK and special colours alone
    try {
      const bmp = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
      const k = Math.min(1, opt.side / Math.max(bmp.width, bmp.height));
      const W = Math.max(1, Math.round(bmp.width * k)), H = Math.max(1, Math.round(bmp.height * k));
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.getContext('2d').drawImage(bmp, 0, 0, W, H);
      if (bmp.close) bmp.close();
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', opt.q));
      const nb = new Uint8Array(await blob.arrayBuffer());
      c.width = c.height = 0;
      if (nb.length >= obj.contents.length) continue;                         // only keep it if it really got smaller
      const nd = d.clone(ctx);
      nd.set(PDFName.of('Width'), PDFNumber.of(W));
      nd.set(PDFName.of('Height'), PDFNumber.of(H));
      nd.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      nd.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      nd.delete(PDFName.of('DecodeParms')); nd.delete(PDFName.of('Decode'));
      nd.set(PDFName.of('Length'), PDFNumber.of(nb.length));
      ctx.assign(ref, PDFRawStream.of(nd, nb));
    } catch (_) { /* an image the browser cannot read stays as it is */ }
  }
  return doc.save({ useObjectStreams: true });
}
async function pagesAsPictures(bytes, opt) {
  const src = await openPdf(bytes);
  const out = await PDFDocument.create();
  for (let i = 1; i <= src.numPages; i++) {
    busy(true, `מקטין עמוד ${i} מתוך ${src.numPages}…`);
    const pg = await src.getPage(i);
    const vp1 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: opt.dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: x, viewport: vp }).promise;
    const img = await out.embedJpg(c.toDataURL('image/jpeg', opt.q));
    c.width = c.height = 0;
    const page = out.addPage([vp1.width, vp1.height]);
    page.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  return out.save({ useObjectStreams: true });
}
async function makeFile(pages) {
  let bytes = await buildPdf(pages);
  const level = $('dlSize').value;
  let before = 0;
  if (level !== 'none') {
    before = bytes.length;
    busy(true, 'מקטין את הקובץ…');
    try {
      const small = level === 'max' ? await pagesAsPictures(bytes, COMPRESS.max) : await shrinkImages(bytes, COMPRESS[level]);
      if (small.length < bytes.length) bytes = small;
    } catch (e) { console.warn('compress', e); }
  }
  const pw = $('dlLock').checked ? $('dlPw').value : '';
  if (pw) { busy(true, 'נועל את הקובץ בסיסמה…'); bytes = await lockPdf(bytes, pw); }
  return { bytes, before, locked: !!pw };
}
async function exportPages(pages, name) {
  busy(true, `מכין קובץ עם ${pages.length} עמודים…`);
  try {
    const { bytes, before, locked } = await makeFile(pages);
    saveBytes(bytes, name);
    if (locked) setTimeout(() => toast('הקובץ נעול בסיסמה. בלי הסיסמה אי אפשר לפתוח אותו, אז כדאי לשמור אותה.', 5500), 5200);
    toast(before && before > bytes.length
      ? `הקובץ ירד והוקטן: ${mb(before)} ← ${mb(bytes.length)} (חיסכון של ${Math.round((1 - bytes.length / before) * 100)}%)`
      : `הקובץ "${name}" ירד (${mb(bytes.length)})`, 5000);
  } catch (e) {
    console.error(e);
    toast('יצירת הקובץ נכשלה. אם הקובץ המקורי מוגן או מוצפן, נסו קובץ אחר.', 6000);
  } finally { busy(false); }
}
const SIZE_NOTES = {
  none: 'הקובץ יוצא כמו שהוא, בלי שינוי באיכות.',
  light: 'התמונות בקובץ נשמרות מחדש באיכות טובה. הטקסט נשאר חד וניתן לסימון. מתאים לרוב המסמכים.',
  strong: 'התמונות מוקטנות יותר. הטקסט נשאר טקסט. מתאים למסמכים עם הרבה צילומים.',
  max: 'כל עמוד הופך לתמונה באיכות בינונית. הקובץ הכי קטן, אבל אי אפשר יותר לסמן או להעתיק את הטקסט המקורי.',
};
function syncSizeNote() { $('dlSizeNote').textContent = SIZE_NOTES[$('dlSize').value]; }
$('dlSize').addEventListener('change', () => { syncSizeNote(); prefs.size = $('dlSize').value; savePrefs(); });
$('downloadBtn').onclick = () => {
  if (!state.pages.length) return;
  const k = state.selected.size;
  $('dlAllLabel').textContent = `הורדת המסמך (${state.pages.length} עמודים)`;
  $('dlSelBtn').hidden = !k;
  const covered = state.pages.some(p => (p.rects || []).some(r => !r.redact));
  $('dlSecureRow').hidden = !covered;
  if (!covered) $('dlSecure').checked = false;
  $('dlSelLabel').textContent = k === 1 ? 'הורדת העמוד שנבחר בלבד' : `הורדת ${k} העמודים שנבחרו`;
  openSheet('dlSheet');
};
$('dlAllBtn').onclick = () => { if (!lockReady()) return; closeSheets(); exportPages(state.pages, outName()); };
const exportSelected = () => {
  if (!lockReady()) return;
  const pages = state.pages.filter(p => state.selected.has(p.id));
  if (pages.length) { closeSheets(); exportPages(pages, outName('-עמודים-נבחרים')); }
};
$('dlSelBtn').onclick = exportSelected;
$('extractBtn').onclick = exportSelected;

/* ---------- Page editor: new text, edit existing text, erase area ---------- */
const ed = { inline: null, pid: null, selId: null, selRect: null, selObj: null, odrag: null, shape: 'rect', vp: null, pg: null, base: null, R: 0, scale: 1, fit: 1, zoom: 1, renderTok: 0, canvas: null, drag: null, draw: null, tap: null, pinch: null, mode: 'text', items: [] };
const edPage = () => state.pages.find(p => p.id === ed.pid);
const edSel = () => edPage()?.overlays.find(o => o.id === ed.selId);
const HINTS = {
  text: 'הקישו על העמוד והתחילו לכתוב. הקשה על טקסט מסמנת אותו, והקשה נוספת פותחת אותו לעריכה. גוררים כדי להזיז.',
  edit: 'בחרו אם הקשה בוחרת אות, מילה או שורה, ולחצו על הטקסט כדי לשנות אותו. סל האשפה בסרגל מחזיר את המקור.',
  erase: 'גררו מלבן על האזור שרוצים למחוק.',
};

async function openEditor(id) {
  closeSheets();
  finishInline();
  if (selecting) { selecting = false; state.selected.clear(); }
  ed.pid = id; ed.selId = null; ed.selRect = null; cancelGestures(); ed.pinch = null; pointers.clear();
  showView('edit');
  renderGrid();
  syncPaste();
  await drawEditor();
}
const DRAW_INFO = {
  rect: ['i-square', 'גררו על העמוד כדי לצייר מלבן'], ellipse: ['i-circle', 'גררו על העמוד כדי לצייר עיגול'],
  line: ['i-line', 'גררו על העמוד כדי למתוח קו'], arrow: ['i-arrow', 'גררו על העמוד כדי לצייר חץ, מההתחלה אל הקצה'],
  mark: ['i-marker', 'הקישו על מילה כדי להדגיש אותה, או גררו על אזור'],
};
function setMode(m) {
  finishInline();
  setTimeout(syncPaste);
  ed.mode = m; ed.selId = null; ed.selRect = null; ed.selObj = null;
  document.querySelectorAll('#edModes .mode').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('stage').dataset.mode = m;
  const drawing = m === 'shape' || m === 'mark';
  $('drawBanner').hidden = !drawing;
  if (drawing) {
    const [icon, label] = DRAW_INFO[m === 'mark' ? 'mark' : ed.shape];
    $('drawIcon').querySelector('use').setAttribute('href', '#' + icon);
    $('drawLabel').textContent = label;
  }
  $('edTextTools').classList.toggle('off', m === 'erase' || drawing);
  $('unitSeg').hidden = m !== 'edit';
  $('eraseTools').hidden = m !== 'erase';
  syncEraseSeg();
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
  Object.assign(ed, { pg, R, items, units: null, base: pg.getViewport({ scale: 1, rotation: R }) });
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
  try { await pg.render({ canvasContext: ctx, viewport: hi, annotationMode: FORMS_OFF }).promise; } catch (e) { console.warn(e); return; }
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
  stage.querySelectorAll('.ov:not(.inline), .er, .ti, .obj, .ff, .crop-mask').forEach(el => el.remove());
  if (!ed.inline) stage.querySelector('.ov.inline')?.remove();
  const rects = p.rects || [];
  for (const r of rects) {
    const v = toView(r);
    const el = document.createElement('div');
    el.className = 'er' + (r.id === ed.selRect ? ' sel' : '') + (r.redact ? ' redact' : '');
    el.dataset.id = r.id;
    Object.assign(el.style, { left: v.left + 'px', top: v.top + 'px', width: v.width + 'px', height: v.height + 'px', background: r.color });
    if (!r.link) el.appendChild(xButton('ביטול המחיקה'));
    stage.appendChild(el);
  }
  drawObjects(p);
  drawFields(p);
  drawCropMask(p);
  if (ed.mode === 'edit' || ed.mode === 'mark') {
    const covers = (p.rects || []).filter(r => r.link);
    for (const u of getUnits()) {
      const cx = (u.x1 + u.x2) / 2, cy = u.y + u.h * 0.3;
      if (covers.some(r => cx > r.x1 && cx < r.x2 && cy > r.y1 && cy < r.y2)) continue;   // already changed
      const v = toView(unitBox(u));
      const el = document.createElement('div');
      el.className = 'ti'; el.dataset.i = u.id; el.title = u.text;
      Object.assign(el.style, { left: v.left + 'px', top: v.top + 'px', width: v.width + 'px', height: v.height + 'px' });
      stage.appendChild(el);
    }
  }
  for (const o of p.overlays) {
    if (o.id === ed.inline) { updateInline(o); continue; }
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

/* ---------- Typing directly on the page ----------
   The selected text turns into a text box drawn in the same font, size, colour and position, so
   the user types where the text is. The text field at the top stays in sync. */
function startInline(o, selectAll) {
  ed.selId = o.id; ed.selRect = null; ed.selObj = null; ed.inline = o.id;
  $('edText').value = o.text; growText();
  drawOverlays();
  const ta = $('stage').querySelector('.ov.inline textarea');
  if (!ta) return;
  ta.focus({ preventScroll: true });
  if (selectAll) ta.select(); else ta.setSelectionRange(ta.value.length, ta.value.length);
}
function updateInline(o) {
  const stage = $('stage'), s = ed.scale;
  let el = stage.querySelector('.ov.inline');
  if (el && +el.dataset.id !== o.id) { el.remove(); el = null; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'ov inline sel'; el.dataset.id = o.id;
    const ta = document.createElement('textarea');
    ta.className = 'ov-edit'; ta.rows = 1; ta.spellcheck = false; ta.setAttribute('aria-label', 'הטקסט');
    ta.value = o.text;
    ta.addEventListener('input', onInlineInput);
    el.appendChild(ta);
    stage.appendChild(el);
  }
  const ta = el.querySelector('textarea');
  if (ta.value !== o.text) ta.value = o.text;
  const img = ovImg(o), lines = String(o.text || ' ').split('\n').length;
  const slack = o.size * 1.2;                          // room for the next letters while typing
  const lh = (o.lh || 1.2) * o.size;
  const rtl = isHebrew(o.text || '') || (!o.text && o.anchor !== 'l');
  const align = o.align || (rtl ? 'r' : 'l');
  Object.assign(ta.style, {
    fontFamily: fontStack(o.font), fontWeight: String(fontWeight(o.font, o.bold)), fontSize: o.size * s + 'px',
    lineHeight: lh * s + 'px', color: o.color, letterSpacing: (o.ls || 0) * o.size * s + 'px',
    fontStyle: o.it ? 'italic' : 'normal', textDecoration: [o.u ? 'underline' : '', o.st ? 'line-through' : ''].join(' ').trim() || 'none',
    textAlign: align === 'c' ? 'center' : align === 'r' ? 'right' : 'left', direction: rtl ? 'rtl' : 'ltr',
    background: o.hl || 'transparent', opacity: String(o.op ?? 1),
    paddingTop: Math.max(0, (o.size - (lh / 2 + o.size * 0.33))) * s + 'px', paddingLeft: img.padL * s + 'px', paddingRight: img.padR * s + 'px',
  });
  const w = img.w + slack, h = Math.max(img.h, lines * lh + o.size * 0.3);
  el.style.width = w * s + 'px'; el.style.height = h * s + 'px';
  // keep the start edge where it is: the box grows to the left in Hebrew, to the right otherwise
  let [cx, cy] = overlayCenter(o, ed.vp, ed.R);
  const a = ovAngle(o, ed.R) * Math.PI / 180;
  const grow = o.anchor === 'r' ? -1 : o.anchor === 'l' ? 1 : 0;
  const dx = grow * slack / 2 * s, dy = (h - img.h) / 2 * s;
  cx += dx * Math.cos(a) + dy * Math.sin(a); cy += -dx * Math.sin(a) + dy * Math.cos(a);
  el.style.left = cx + 'px'; el.style.top = cy + 'px';
  el.style.transform = `translate(-50%, -50%) rotate(${-ovAngle(o, ed.R)}deg)`;
}
function onInlineInput(e) {
  const p = edPage(), o = p && p.overlays.find(x => x.id === ed.inline); if (!o) return;
  beginBurst();
  // new text typed from an empty box keeps its starting edge in place
  if (o.fresh && !o.anchor && e.target.value) {
    const img = ovImg(o), [cx] = [o.px];
    o.anchor = isHebrew(e.target.value) ? 'r' : 'l';
    const half = (img.w / 2 - (o.anchor === 'l' ? img.padL : img.padR));
    const th = o.ang * Math.PI / 180;
    o.px = cx + (o.anchor === 'r' ? 1 : -1) * half * Math.cos(th);
    o.py = o.py + (o.anchor === 'r' ? 1 : -1) * half * Math.sin(th);
  }
  o.text = e.target.value;
  $('edText').value = o.text; growText();
  updateInline(o);
  positionFmtBar();
}
/* The top field mirrors the selected text; once that text is let go, the field is cleared so the next tap starts fresh */
function releaseField(o) { if (o && $('edText').value === o.text) { $('edText').value = ''; growText(); } }
function finishInline() {
  if (typeof ed === 'undefined' || !ed.inline) return;
  const p = edPage(), o = p && p.overlays.find(x => x.id === ed.inline);
  ed.inline = null;
  $('stage').querySelector('.ov.inline')?.remove();
  if (o) {
    delete o.fresh;
    releaseField(o);
    if (!o.text.trim() && o.srcItem == null) { p.overlays = p.overlays.filter(x => x !== o); ed.selId = null; $('edText').value = ''; growText(); }
  }
  drawOverlays();
  renderGrid();
}
/* Toolbar buttons must not take the keyboard away from the text being typed */
['fmtBar', 'objBar'].forEach(id => $(id).addEventListener('mousedown', (e) => { if (!e.target.closest('input, select')) e.preventDefault(); }));

/* ---------- Text style: floating toolbar and sheets ---------- */
function loadPrefs() {
  const d = { lock: true, unit: 'word', recent: [] };
  try { return Object.assign(d, JSON.parse(localStorage.getItem('dafdaf.prefs') || '{}')); } catch (_) { return d; }
}
function savePrefs() { try { localStorage.setItem('dafdaf.prefs', JSON.stringify(prefs)); } catch (_) {} }
const prefs = loadPrefs();
if (!['letter', 'word', 'line'].includes(prefs.unit)) prefs.unit = prefs.lineMode ? 'line' : 'word';
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
  positionObjBar();
  const show = edActive() && !['erase', 'shape', 'mark'].includes(ed.mode) && !ed.selObj && (!!ed.selId || fmtOpen);
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
  const ta = $('stage').querySelector('.ov.inline textarea'); if (ta && ta.value !== o.text) ta.value = o.text;
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
const ERASE_NOTES = {
  cover: 'כיסוי בצבע הדף: מסתיר את האזור, אבל מה שמתחתיו נשאר בתוך הקובץ. מתאים לניקוי והסתרת טעויות, לא למידע רגיש.',
  redact: 'השחרה מאובטחת: בהורדה, מה שמתחת למלבן השחור נמחק מהקובץ לגמרי. העמוד הזה יישמר כתמונה (טקסט שהוספתם נשאר טקסט).',
};
function syncEraseSeg() {
  if (!['cover', 'redact'].includes(prefs.erase)) prefs.erase = 'cover';
  $('eraseSeg').querySelectorAll('[data-erase]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.erase === prefs.erase)));
  $('eraseNote').textContent = ERASE_NOTES[prefs.erase];
}
$('eraseSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-erase]'); if (!b) return;
  prefs.erase = b.dataset.erase; savePrefs(); syncEraseSeg();
});
function syncUnitSeg() { $('unitSeg').querySelectorAll('[data-unit]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.unit === prefs.unit))); }
$('unitSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-unit]'); if (!b) return;
  prefs.unit = b.dataset.unit; savePrefs(); syncUnitSeg(); drawOverlays();
});
syncUnitSeg();
if (prefs.size && SIZE_NOTES[prefs.size]) $('dlSize').value = prefs.size;
syncSizeNote();

document.querySelectorAll('#edModes .mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.addEventListener('keydown', (e) => {
  if (!edActive()) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && ed.selObj) { e.preventDefault(); deleteObj(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && (ed.selId || ed.selRect)) {
    e.preventDefault(); snapshot();
    const p = edPage();
    if (ed.selId) removeOverlay(p, ed.selId); else p.rects = (p.rects || []).filter(r => r.id !== ed.selRect);
    ed.selId = null; ed.selRect = null; drawOverlays();
  }
});
function leaveEditor() { finishInline(); $('pasteBtn').hidden = true; cancelGestures(); hideGuide(); showView('pages'); renderGrid(); }
$('edPrev').onclick = () => { const n = idxOf(ed.pid); if (n > 0) openEditor(state.pages[n - 1].id); };
$('edNext').onclick = () => { const n = idxOf(ed.pid); if (n < state.pages.length - 1) openEditor(state.pages[n + 1].id); };
window.addEventListener('resize', () => { if (edActive() && ed.pg) { clearTimeout(ed.rt); ed.rt = setTimeout(() => { computeFit(); layoutEditor(); scheduleRender(); }, 200); } });

ensureFont('heebo').then(() => { if (state.pages.length) renderGrid(); });
onSettings();
renderGrid();

/* ---------- Objects: signatures, images, shapes, highlights ---------- */
const SHAPE_COLORS = ['#c0392b', '#1a3fb0', '#0f766e', '#111827', '#f59e0b', '#7c3aed'];
const MARK_COLORS = ['#ffe94d', '#9be27a', '#7cd3ff', '#ff9ccf', '#ffb870'];
const edObj = () => (edPage()?.objs || []).find(o => o.id === ed.selObj);
function selectObj(id) { ed.selObj = id; ed.selId = null; ed.selRect = null; drawOverlays(); }
function drawObjects(p) {
  const stage = $('stage');
  for (const o of p.objs || []) {
    const el = document.createElement('div');
    el.className = 'obj' + (o.id === ed.selObj ? ' sel' : '');
    el.dataset.id = o.id;
    placeObjEl(el, o);
    const im = document.createElement('img');
    im.src = assets.get(o.asset) || ''; im.alt = ''; im.draggable = false;
    im.style.opacity = o.op ?? 1;
    el.appendChild(im);
    const rs = document.createElement('span'); rs.className = 'rs'; rs.setAttribute('aria-label', 'שינוי גודל');
    el.appendChild(rs);
    stage.appendChild(el);
  }
}
function placeObjEl(el, o) {
  const [cx, cy] = ed.vp.convertToViewportPoint(o.cx, o.cy);
  Object.assign(el.style, { left: cx + 'px', top: cy + 'px', width: o.w * ed.scale + 'px', height: o.h * ed.scale + 'px',
    transform: `translate(-50%, -50%) rotate(${-(o.ang - ed.R + (o.rot || 0))}deg)` });
}
function moveObj(e) {
  const g = ed.odrag, o = g.o;
  if (!g.moved) { snapshot(); g.moved = true; }
  const [mx, my] = stagePoint(e);
  if (g.resize) {
    const fx = Math.abs(mx - g.cx) / Math.max(4, g.d0x), fy = Math.abs(my - g.cy) / Math.max(4, g.d0y);
    if (o.keep) { const f = Math.max(0.05, Math.max(fx, fy)); o.w = Math.max(8, g.w0 * f); o.h = Math.max(8, g.h0 * f); }
    else { o.w = Math.max(6, g.w0 * fx); o.h = Math.max(6, g.h0 * fy); }
  } else {
    const [sx, sy] = snapObject(o, mx - g.dx, my - g.dy);
    [o.cx, o.cy] = ed.vp.convertToPdfPoint(sx, sy);
  }
  const el = $('stage').querySelector(`.obj[data-id="${o.id}"]`);
  if (el) placeObjEl(el, o);
  positionObjBar();
}
function endObjDrag() {
  const g = ed.odrag; ed.odrag = null;
  clearSnapLines();
  if (g.resize && g.moved && g.o.kind === 'shape') { renderShape(g.o); }   // keep line widths crisp after resizing
  drawOverlays();
  if (g.moved) renderGrid();
}
/* Shapes are drawn into a picture; resizing redraws them so lines keep their thickness */
function renderShape(o) {
  const K = Math.min(4, 2400 / Math.max(o.w, o.h, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(o.w * K)); c.height = Math.max(2, Math.round(o.h * K));
  const x = c.getContext('2d');
  x.scale(K, K);
  const sw = o.sw || 2.5, w = o.w, h = o.h;
  x.strokeStyle = o.color; x.fillStyle = o.color; x.lineWidth = sw; x.lineCap = 'round'; x.lineJoin = 'round';
  if (o.shape === 'mark') { x.fillRect(0, 0, w, h); }
  else if (o.shape === 'rect') {
    if (o.fill) { x.globalAlpha = 0.25; x.fillRect(sw / 2, sw / 2, w - sw, h - sw); x.globalAlpha = 1; }
    x.strokeRect(sw / 2, sw / 2, w - sw, h - sw);
  } else if (o.shape === 'ellipse') {
    x.beginPath(); x.ellipse(w / 2, h / 2, Math.max(1, w / 2 - sw / 2), Math.max(1, h / 2 - sw / 2), 0, 0, Math.PI * 2);
    if (o.fill) { x.globalAlpha = 0.25; x.fill(); x.globalAlpha = 1; }
    x.stroke();
  } else {
    const pad = o.pad || 0;
    const ax = o.fx ? w - pad : pad, ay = o.fy ? h - pad : pad, bx = o.fx ? pad : w - pad, by = o.fy ? pad : h - pad;
    x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke();
    if (o.shape === 'arrow') {
      const ang = Math.atan2(by - ay, bx - ax), L = Math.max(9, sw * 4);
      x.beginPath();
      x.moveTo(bx, by); x.lineTo(bx - L * Math.cos(ang - 0.45), by - L * Math.sin(ang - 0.45));
      x.lineTo(bx - L * Math.cos(ang + 0.45), by - L * Math.sin(ang + 0.45)); x.closePath(); x.fill();
    }
  }
  o.asset = addAsset(c.toDataURL('image/png'));
}
/* A shape or highlight drawn from (x0,y0) to (x1,y1) in screen coordinates of the page */
function addShapeFromView(kind, x0, y0, x1, y1) {
  const p = edPage(); if (!p) return;
  const s = ed.scale, isLine = kind === 'line' || kind === 'arrow';
  const sw = 2.5, pad = isLine ? Math.max(8, sw * 4) : 0;
  const w = Math.abs(x1 - x0) / s + pad * 2, h = Math.abs(y1 - y0) / s + pad * 2;
  const [cx, cy] = ed.vp.convertToPdfPoint((x0 + x1) / 2, (y0 + y1) / 2);
  const o = {
    id: uid++, kind: kind === 'mark' ? 'mark' : 'shape', shape: kind, cx, cy, w, h, ang: ed.R, rot: 0,
    color: kind === 'mark' ? MARK_COLORS[0] : (prefs.shapeColor || SHAPE_COLORS[0]), sw, pad, fx: x1 < x0, fy: y1 < y0,
    op: kind === 'mark' ? 0.45 : 1, keep: false,
  };
  renderShape(o);
  snapshot();
  p.objs = p.objs || []; p.objs.push(o);
  if (kind !== 'mark') { setMode('text'); }
  selectObj(o.id);
  renderGrid();
}
/* Where a new picture goes: the middle of the part of the page that is on screen */
function visibleCenter() {
  const b = $('edBody').getBoundingClientRect(), r = $('stage').getBoundingClientRect();
  const x = (Math.max(b.left, r.left) + Math.min(b.right, r.right)) / 2 - r.left;
  const y = (Math.max(b.top, r.top) + Math.min(b.bottom, r.bottom)) / 2 - r.top;
  return ed.vp.convertToPdfPoint(Math.max(0, Math.min(r.width, x)), Math.max(0, Math.min(r.height, y)));
}
async function addPicture(dataUrl, kind, widthPt) {
  const p = edPage(); if (!p) return;
  const im = new Image(); im.src = dataUrl; await im.decode();
  const asset = addAsset(dataUrl);
  const w = widthPt, h = w * im.naturalHeight / im.naturalWidth;
  const [cx, cy] = visibleCenter();
  const o = { id: uid++, kind, asset, cx, cy, w, h, ang: ed.R, rot: 0, op: 1, keep: true };
  snapshot();
  p.objs = p.objs || []; p.objs.push(o);
  setMode('text');
  selectObj(o.id);
  renderGrid();
  toast('גררו כדי להזיז. העיגול בפינה משנה את הגודל.', 3500);
}
function deleteObj() {
  const p = edPage(); if (!p || !ed.selObj) return;
  snapshot();
  p.objs = (p.objs || []).filter(o => o.id !== ed.selObj);
  ed.selObj = null; drawOverlays(); renderGrid();
}

/* Object toolbar: colour, line thickness, fill, duplicate, delete */
function positionObjBar() {
  const bar = $('objBar'), o = edActive() ? edObj() : null;
  bar.hidden = !o;
  if (!o) return;
  const shape = o.kind === 'shape', mark = o.kind === 'mark';
  const colors = mark ? MARK_COLORS : SHAPE_COLORS;
  const box = $('obColors');
  if (box.dataset.for !== o.kind + ':' + o.color) {
    box.replaceChildren(...((shape || mark) ? colors.map(col => {
      const b = document.createElement('button');
      b.type = 'button'; b.style.background = col; b.dataset.col = col; b.setAttribute('aria-label', 'צבע');
      b.setAttribute('aria-pressed', String(o.color === col));
      return b;
    }) : []));
    box.dataset.for = o.kind + ':' + o.color;
  }
  box.hidden = !(shape || mark); $('obSep').hidden = !(shape || mark);
  const isLine = shape && (o.shape === 'line' || o.shape === 'arrow');
  $('obThin').hidden = $('obThick').hidden = !shape;
  $('obFill').hidden = !(shape && !isLine);
  $('obThin').setAttribute('aria-pressed', String((o.sw || 2.5) < 3));
  $('obThick').setAttribute('aria-pressed', String((o.sw || 2.5) >= 3));
  $('obFill').setAttribute('aria-pressed', String(!!o.fill));
  const el = $('stage').querySelector(`.obj[data-id="${o.id}"]`);
  const view = $('editView').getBoundingClientRect(), body = $('edBody').getBoundingClientRect();
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const minTop = body.top - view.top + 8;
  let top = minTop, left = (view.width - bw) / 2;
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.bottom > body.top && r.top < body.bottom) {
      top = r.top - view.top - bh - 16;
      if (top < minTop) top = r.bottom - view.top + 18;
      if (top + bh > body.bottom - view.top - 4) top = minTop;
      left = r.left + r.width / 2 - view.left - bw / 2;
    }
  }
  bar.style.top = Math.max(minTop, top) + 'px';
  bar.style.left = Math.max(8, Math.min(view.width - bw - 8, left)) + 'px';
}
function editObj(patch) {
  const o = edObj(); if (!o) return;
  snapshot(); Object.assign(o, patch);
  if (o.kind === 'shape' || o.kind === 'mark') renderShape(o);
  if (patch.color && o.kind === 'shape') { prefs.shapeColor = patch.color; savePrefs(); }
  drawOverlays(); renderGrid();
}
$('obColors').addEventListener('click', (e) => { const b = e.target.closest('[data-col]'); if (b) editObj({ color: b.dataset.col }); });
$('obThin').onclick = () => editObj({ sw: 1.5 });
$('obThick').onclick = () => editObj({ sw: 4.5 });
$('obFill').onclick = () => { const o = edObj(); if (o) editObj({ fill: !o.fill }); };
$('obDel').onclick = deleteObj;
$('obDup').onclick = () => {
  const p = edPage(), o = edObj(); if (!p || !o) return;
  snapshot();
  const off = 14;
  const [vx, vy] = ed.vp.convertToViewportPoint(o.cx, o.cy);
  const [cx, cy] = ed.vp.convertToPdfPoint(vx + off, vy + off);
  const c = { ...o, id: uid++, cx, cy };
  p.objs.push(c); selectObj(c.id); renderGrid();
};

/* ---------- Alignment guides ----------
   While a picture or shape is moved, its centre and edges snap to the page centre and to the
   centres and edges of the other items; a pink line shows what it lines up with. */
function clearSnapLines() { $('stage').querySelectorAll('.snapline').forEach(el => el.remove()); }
function snapObject(o, x, y) {
  clearSnapLines();
  const p = edPage(), s = ed.scale, T = 6;
  const hw = o.w * s / 2, hh = o.h * s / 2;
  const xs = [ed.vp.width / 2], ys = [ed.vp.height / 2];
  for (const q of p.objs || []) {
    if (q.id === o.id) continue;
    const [qx, qy] = ed.vp.convertToViewportPoint(q.cx, q.cy), qw = q.w * s / 2, qh = q.h * s / 2;
    xs.push(qx, qx - qw, qx + qw); ys.push(qy, qy - qh, qy + qh);
  }
  const best = (vals, mine) => {
    let r = null;
    for (const v of vals) for (const [k, m] of mine.entries()) { const d = v - m; if (Math.abs(d) <= T && (!r || Math.abs(d) < Math.abs(r.d))) r = { d, at: v, k }; }
    return r;
  };
  const bx = best(xs, [x, x - hw, x + hw]), by = best(ys, [y, y - hh, y + hh]);
  if (bx) { x += bx.d; line('v', bx.at); }
  if (by) { y += by.d; line('h', by.at); }
  function line(dir, at) {
    const l = document.createElement('div');
    l.className = 'snapline ' + dir;
    if (dir === 'v') l.style.left = at + 'px'; else l.style.top = at + 'px';
    $('stage').appendChild(l);
  }
  return [x, y];
}

/* ---------- Copy and paste ---------- */
let clip = null;
function copySelection() {
  const p = edPage(); if (!p) return false;
  const o = edSel(), ob = edObj();
  if (o) clip = { kind: 'ov', data: JSON.parse(JSON.stringify(o)) };
  else if (ob) clip = { kind: 'obj', data: JSON.parse(JSON.stringify(ob)) };
  else return false;
  syncPaste();
  toast('הועתק. אפשר להדביק בכל עמוד.', 2200);
  return true;
}
function pasteClip() {
  const p = edPage(); if (!p || !clip) return;
  finishInline();
  snapshot();
  const [cx, cy] = visibleCenter();
  if (clip.kind === 'ov') {
    const o = { ...clip.data, id: uid++, px: cx, py: cy, ang: ed.R };
    delete o.srcItem; delete o.srcItems; delete o.rectId; delete o.srcY; delete o.anchor; delete o.vb; delete o.fresh;
    p.overlays.push(o); ed.selId = o.id; ed.selObj = null; loadFields(o);
  } else {
    const o = { ...clip.data, id: uid++, cx, cy, ang: ed.R };
    p.objs = p.objs || []; p.objs.push(o); ed.selObj = o.id; ed.selId = null;
  }
  drawOverlays(); renderGrid();
}
function syncPaste() { $('pasteBtn').hidden = !(clip && edActive() && !['shape', 'mark', 'erase'].includes(ed.mode)); }
$('fbCopy').onclick = copySelection;
$('obCopy').onclick = copySelection;
$('pasteBtn').onclick = pasteClip;
document.addEventListener('keydown', (e) => {
  if (!edActive() || !(e.ctrlKey || e.metaKey)) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'c' && copySelection()) e.preventDefault();
  else if (k === 'v' && clip) { e.preventDefault(); pasteClip(); }
});

/* ---------- Crop margins ---------- */
let cropState = null;
const MM = 72 / 25.4;
async function openCrop(id) {
  const p = state.pages.find(x => x.id === id); if (!p) return;
  const pg = await getPage(p.src, p.idx), R = totalRot(pg, p);
  const vp1 = pg.getViewport({ scale: 1, rotation: R });
  const scale = Math.min(300 / vp1.width, 300 / vp1.height);
  const vp = pg.getViewport({ scale, rotation: R });
  const c = $('cropCanvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: FORMS_OFF }).promise;
  const page = ctx.getImageData(0, 0, c.width, c.height);
  // current margins in millimetres, as the page is shown
  let m = { t: 0, r: 0, b: 0, l: 0 };
  if (p.crop) {
    const [a, b2, cc, d] = vp1.convertToViewportRectangle([p.crop.x1, p.crop.y1, p.crop.x2, p.crop.y2]);
    const L = Math.min(a, cc), T = Math.min(b2, d), Rr = Math.max(a, cc), B = Math.max(b2, d);
    m = { t: T / MM, l: L / MM, r: (vp1.width - Rr) / MM, b: (vp1.height - B) / MM };
  }
  cropState = { p, pg, R, vp1, vp, page, m };
  const maxV = Math.floor(vp1.height / MM * 0.45), maxH = Math.floor(vp1.width / MM * 0.45);
  for (const [k, max] of [['t', maxV], ['b', maxV], ['r', maxH], ['l', maxH]]) { const el = $('crop_' + k); el.max = max; el.value = Math.round(m[k]); }
  $('cropAll').checked = false;
  drawCropPreview();
  openSheet('cropSheet');
}
function drawCropPreview() {
  const st = cropState; if (!st) return;
  const c = $('cropCanvas'), ctx = c.getContext('2d'), k = st.vp.scale * MM;
  ctx.putImageData(st.page, 0, 0);
  const m = st.m, x = m.l * k, y = m.t * k, w = c.width - (m.l + m.r) * k, h = c.height - (m.t + m.b) * k;
  ctx.fillStyle = 'rgba(15, 23, 32, .55)';
  ctx.fillRect(0, 0, c.width, y); ctx.fillRect(0, y + h, c.width, c.height - y - h);
  ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, c.width - x - w, h);
  ctx.strokeStyle = '#14b8a6'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  for (const kk of ['t', 'b', 'r', 'l']) $('crop_' + kk + '_v').textContent = Math.round(m[kk]) + ' מ״מ';
}
['t', 'b', 'r', 'l'].forEach(k => $('crop_' + k).addEventListener('input', () => { cropState.m[k] = +$('crop_' + k).value; drawCropPreview(); }));
/* Trim white margins: find where the content starts on each side */
$('cropAuto').onclick = () => {
  const st = cropState; if (!st) return;
  const { data, width, height } = st.page;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (data[i] < 238 || data[i + 1] < 238 || data[i + 2] < 238) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) { toast('העמוד ריק, אין מה לחתוך'); return; }
  const k = st.vp.scale * MM, pad = 5;    // keep 5 mm around the content
  st.m = { l: Math.max(0, x0 / k - pad), t: Math.max(0, y0 / k - pad), r: Math.max(0, (width - x1) / k - pad), b: Math.max(0, (height - y1) / k - pad) };
  for (const kk of ['t', 'b', 'r', 'l']) $('crop_' + kk).value = Math.round(st.m[kk]);
  drawCropPreview();
};
$('cropReset').onclick = () => { cropState.m = { t: 0, r: 0, b: 0, l: 0 }; ['t', 'b', 'r', 'l'].forEach(k => { $('crop_' + k).value = 0; }); drawCropPreview(); };
async function cropFor(p, m) {
  const pg = await getPage(p.src, p.idx), vp1 = pg.getViewport({ scale: 1, rotation: totalRot(pg, p) });
  if (!m.t && !m.r && !m.b && !m.l) return null;
  const L = m.l * MM, T = m.t * MM, Rr = vp1.width - m.r * MM, B = vp1.height - m.b * MM;
  if (Rr - L < 36 || B - T < 36) return undefined;           // too small to keep
  const [ax, ay] = vp1.convertToPdfPoint(L, T), [bx, by] = vp1.convertToPdfPoint(Rr, B);
  return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
}
$('cropApply').onclick = async () => {
  const st = cropState; if (!st) return;
  const targets = $('cropAll').checked ? state.pages : [st.p];
  const crops = [];
  for (const p of targets) crops.push([p, await cropFor(p, st.m)]);
  if (crops.some(([, c]) => c === undefined)) { toast('החיתוך גדול מדי: לא נשאר מספיק מהעמוד.', 4000); return; }
  snapshot();
  for (const [p, c] of crops) { if (c) p.crop = c; else delete p.crop; }
  closeSheets(); renderGrid(); if (edActive()) drawOverlays();
  toast(targets.length > 1 ? 'החיתוך הוחל על כל העמודים' : 'העמוד נחתך');
};
/* A cropped thumbnail shows only what stays */
function cropCanvas(canvas, vp, crop) {
  const [a, b, c, d] = vp.convertToViewportRectangle([crop.x1, crop.y1, crop.x2, crop.y2]);
  const x = Math.max(0, Math.round(Math.min(a, c))), y = Math.max(0, Math.round(Math.min(b, d)));
  const w = Math.max(1, Math.round(Math.abs(c - a))), h = Math.max(1, Math.round(Math.abs(d - b)));
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}
/* In the editor the part that is cut away is dimmed */
function drawCropMask(p) {
  if (!p.crop) return;
  const v = toView(p.crop), W = ed.vp.width, H = ed.vp.height;
  const parts = [[0, 0, W, v.top], [0, v.top + v.height, W, H - v.top - v.height], [0, v.top, v.left, v.height], [v.left + v.width, v.top, W - v.left - v.width, v.height]];
  for (const [x, y, w, h] of parts) {
    if (w <= 0 || h <= 0) continue;
    const el = document.createElement('div'); el.className = 'crop-mask';
    Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    $('stage').appendChild(el);
  }
}

/* ---------- Insert sheet ---------- */
async function ensureEditor() {
  if (!edActive()) await openEditor(idxOf(ed.pid) >= 0 ? ed.pid : state.pages[0].id);
}
$('insertSheet').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ins]'); if (!b) return;
  const k = b.dataset.ins;
  closeSheets();
  if (k === 'sign') { openSignature(); return; }
  if (k === 'blank') { const pg = await insertBlank(edActive() ? ed.pid : (state.pages[state.pages.length - 1] || {}).id); if (edActive() && pg) openEditor(pg.id); return; }
  if (k === 'image') { $('imgInput').click(); return; }
  await ensureEditor();
  if (k === 'mark') { setMode('mark'); return; }
  if (['rect', 'ellipse', 'line', 'arrow'].includes(k)) { ed.shape = k; setMode('shape'); return; }
  if (k === 'text') { setMode('text'); fmtOpen = true; syncFmtBar(); $('edText').focus(); toast('כתבו את הטקסט והקישו על המקום בעמוד', 3500); return; }
  if (k === 'date') {
    const p = edPage(), d = new Date();
    const text = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const [px, py] = visibleCenter();
    const o = { id: uid++, text, ...styleCopy(defStyle), px, py, ang: ed.R };
    snapshot(); p.overlays.push(o);
    setMode('text'); ed.selId = o.id; loadFields(o); drawOverlays(); renderGrid();
  }
});
$('drawDone').onclick = () => setMode('text');

/* Images: shrink big photos so the PDF stays small */
function readImage(file, maxSide = 1800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      const x = c.getContext('2d');
      const png = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
      if (!png) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
      x.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ url: png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.86), w: c.width, h: c.height });
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    im.src = url;
  });
}
$('imgInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const img = await readImage(f);
    await ensureEditor();
    await addPicture(img.url, 'img', ed.base.width * 0.45);
  } catch (_) { toast('לא הצלחתי לפתוח את התמונה. נסו תמונה אחרת.', 4000); }
};

/* ---------- Tools sheet ---------- */
function openTools() {
  const s0 = settings();
  $('wmState').textContent = s0.wm.on ? `פעיל: "${s0.wm.text}"` : 'כבוי';
  $('pnState').textContent = s0.pn.on ? 'פעיל' : 'כבוי';
  openSheet('toolsSheet');
}
$('toolsSheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]'); if (!b) return;
  const k = b.dataset.tool;
  if (k === 'wm') openSheet('wmSheet');
  else if (k === 'pn') openSheet('pnSheet');
  else if (k === 'addpdf') { closeSheets(); $('fileInput').click(); }
  else if (k === 'imgpages') { closeSheets(); $('imgPagesInput').click(); }
  else if (k === 'select') { closeSheets(); if (edActive()) leaveEditor(); startSelecting(); }
  else if (k === 'shrink') { if ($('dlSize').value === 'none') $('dlSize').value = 'light'; syncSizeNote(); $('downloadBtn').click(); }
});
/* Photos become A4 pages (portrait or landscape to match each photo) */
$('imgPagesInput').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  busy(true, 'הופך תמונות לעמודים…');
  try {
    const doc = await PDFDocument.create();
    for (const f of files) {
      const img = await readImage(f, 2200);
      const emb = img.url.startsWith('data:image/jpeg') ? await doc.embedJpg(img.url) : await doc.embedPng(img.url);
      const land = img.w > img.h, W = land ? 841.89 : 595.28, H = land ? 595.28 : 841.89, m = 18;
      const k = Math.min((W - 2 * m) / img.w, (H - 2 * m) / img.h);
      const page = doc.addPage([W, H]);
      page.drawImage(emb, { x: (W - img.w * k) / 2, y: (H - img.h * k) / 2, width: img.w * k, height: img.h * k });
    }
    const before = JSON.stringify(state.pages);
    await addBytes(await doc.save(), files.length === 1 ? 'תמונה.pdf' : 'תמונות.pdf');
    history.push(before); $('undoBtn').disabled = false;
    renderGrid();
    toast(files.length === 1 ? 'התמונה נוספה כעמוד' : `${files.length} תמונות נוספו כעמודים`);
  } catch (_) { toast('לא הצלחתי להוסיף את התמונות. נסו שוב.', 4000); }
  finally { busy(false); }
};

/* ---------- Signature ---------- */
const SIG_COLORS = ['#111827', '#1a3fb0', '#0f766e'];
const sig = { strokes: [], color: SIG_COLORS[0], drawing: null };
function loadSigs() { try { return JSON.parse(localStorage.getItem('mypdf.sigs') || '[]'); } catch (_) { return []; } }
function saveSigs(list) { try { localStorage.setItem('mypdf.sigs', JSON.stringify(list.slice(0, 4))); } catch (_) {} }
function openSignature() {
  sig.strokes = []; $('sigUse').disabled = true;
  renderSavedSigs();
  $('sigColors').replaceChildren(...SIG_COLORS.map(col => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swb sm'; b.style.background = col; b.setAttribute('aria-label', 'צבע החתימה');
    b.setAttribute('aria-pressed', String(sig.color === col));
    b.onclick = () => { sig.color = col; $('sigColors').querySelectorAll('.swb').forEach(x => x.setAttribute('aria-pressed', String(x === b))); paintSig(); };
    return b;
  }));
  openSheet('sigSheet');
  requestAnimationFrame(sizeSigPad);
}
function renderSavedSigs() {
  const list = loadSigs();
  $('sigSavedWrap').hidden = !list.length;
  $('sigPadLabel').textContent = list.length ? 'או חתימה חדשה: חתמו באצבע בתוך המסגרת' : 'חתמו באצבע או בעכבר בתוך המסגרת';
  $('sigSaved').replaceChildren(...list.map((url, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sig-item'; b.setAttribute('aria-label', 'הוספת החתימה השמורה');
    const im = document.createElement('img'); im.src = url; im.alt = '';
    const del = document.createElement('span'); del.className = 'sig-del'; del.setAttribute('aria-label', 'מחיקת החתימה השמורה');
    del.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
    b.append(im, del);
    b.onclick = async (ev) => {
      if (ev.target.closest('.sig-del')) { const l = loadSigs(); l.splice(i, 1); saveSigs(l); renderSavedSigs(); return; }
      closeSheets(); await placeSignature(url);
    };
    return b;
  }));
}
function sizeSigPad() {
  const c = $('sigPad'), r = c.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  paintSig();
}
function paintSig() {
  const c = $('sigPad'), x = c.getContext('2d'), dpr = c.width / (c.getBoundingClientRect().width || 1);
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.strokeStyle = sig.color; x.lineCap = 'round'; x.lineJoin = 'round';
  for (const st of sig.strokes) {
    if (st.length === 1) { x.fillStyle = sig.color; x.beginPath(); x.arc(st[0].x, st[0].y, 1.4, 0, Math.PI * 2); x.fill(); continue; }
    // smooth curve through the points; faster strokes come out a little thinner, like ink
    for (let i = 1; i < st.length; i++) {
      const a = st[i - 1], b = st[i];
      x.lineWidth = Math.max(1.3, 3.2 - Math.min(2, Math.hypot(b.x - a.x, b.y - a.y) / 9));
      x.beginPath();
      const mx0 = i > 1 ? (st[i - 2].x + a.x) / 2 : a.x, my0 = i > 1 ? (st[i - 2].y + a.y) / 2 : a.y;
      x.moveTo(mx0, my0); x.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2); x.stroke();
    }
  }
}
const sigPt = (e) => { const r = $('sigPad').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
$('sigPad').addEventListener('pointerdown', (e) => {
  e.preventDefault(); $('sigPad').setPointerCapture(e.pointerId);
  sig.drawing = [sigPt(e)]; sig.strokes.push(sig.drawing); paintSig();
});
$('sigPad').addEventListener('pointermove', (e) => { if (!sig.drawing) return; sig.drawing.push(sigPt(e)); paintSig(); });
['pointerup', 'pointercancel'].forEach(t => $('sigPad').addEventListener(t, () => { if (sig.drawing) { sig.drawing = null; $('sigUse').disabled = !sig.strokes.length; } }));
$('sigClear').onclick = () => { sig.strokes = []; $('sigUse').disabled = true; paintSig(); };
/* Cut the empty space around the signature and keep a transparent background */
function sigImage() {
  const c = $('sigPad'), x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let xx = 0; xx < c.width; xx++) {
    if (d[(y * c.width + xx) * 4 + 3] > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 <= x0 || y1 <= y0) return null;
  const pad = 6, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
  const o = document.createElement('canvas'); o.width = w; o.height = h;
  o.getContext('2d').drawImage(c, x0 - pad, y0 - pad, w, h, 0, 0, w, h);
  return o.toDataURL('image/png');
}
$('sigUse').onclick = async () => {
  const url = sigImage(); if (!url) return;
  if ($('sigKeep').checked) { const l = loadSigs().filter(u => u !== url); l.unshift(url); saveSigs(l); }
  closeSheets();
  await placeSignature(url);
};
async function placeSignature(url) {
  await ensureEditor();
  await addPicture(url, 'sig', Math.min(170, ed.base.width * 0.32));
}

/* ---------- Share the finished PDF ---------- */
const canShareFiles = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'a.pdf', { type: 'application/pdf' })] })); } catch (_) { return false; } })();
$('shareBtn').hidden = !canShareFiles;
$('shareBtn').onclick = async () => {
  if (!lockReady()) return;
  closeSheets();
  busy(true, 'מכין את הקובץ לשיתוף…');
  let bytes;
  try { bytes = (await makeFile(state.pages)).bytes; } catch (e) { busy(false); toast('יצירת הקובץ נכשלה.', 5000); return; }
  busy(false);
  const name = outName();
  const file = new File([bytes], name, { type: 'application/pdf' });
  try { await navigator.share({ files: [file], title: name }); }
  catch (e) { if (e && e.name !== 'AbortError') { saveBytes(bytes, name); toast('השיתוף לא זמין כאן, אז הקובץ ירד למכשיר.', 4500); } }
};

/* ---------- Passwords ----------
   Locked files are opened with the password once, and a plain copy is kept (only on this device);
   a downloaded file can be locked with a password (AES-256). Both use a second build of the PDF
   library that knows encryption, loaded only when needed. */
let cryptLib = null;
function loadCrypt() {
  return cryptLib || (cryptLib = new Promise((res) => {
    const orig = window.PDFLib, sc = document.createElement('script');
    sc.src = 'vendor/pdf-lib-crypt.min.js';
    sc.onload = () => { const lib = window.PDFLib; window.PDFLib = orig; res(lib); };
    sc.onerror = () => { window.PDFLib = orig; cryptLib = null; res(null); };
    document.head.appendChild(sc);
  }));
}
async function decryptPdf(bytes, password) {
  const L = await loadCrypt(); if (!L) throw new Error('crypt unavailable');
  const src = await L.PDFDocument.load(bytes, { password });
  const out = await L.PDFDocument.create();
  (await out.copyPages(src, src.getPageIndices())).forEach(pg => out.addPage(pg));
  return out.save();
}
async function lockPdf(bytes, password) {
  const L = await loadCrypt(); if (!L) throw new Error('crypt unavailable');
  const d = await L.PDFDocument.load(bytes);
  const owner = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  d.encrypt({ userPassword: password, ownerPassword: owner,
    permissions: { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true } });
  return d.save();
}
async function unlockIfNeeded(bytes, name) {
  let encrypted = false;
  try { encrypted = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).isEncrypted; } catch (_) {}
  if (!encrypted) return bytes;
  try { return await decryptPdf(bytes, ''); } catch (_) {}      // only restricted (printing, copying), no password to open
  let wrong = false;
  for (;;) {
    busy(false);
    const pw = await askPassword(name, wrong);
    if (pw == null) return null;
    busy(true, 'פותח את הקובץ…');
    try { return await decryptPdf(bytes, pw); } catch (_) { wrong = true; }
  }
}
function askPassword(name, wrong) {
  return new Promise((resolve) => {
    $('pwName').textContent = name;
    $('pwError').hidden = !wrong;
    $('pwInput').value = ''; $('pwInput').type = 'password'; $('pwShow').setAttribute('aria-pressed', 'false');
    const done = (v) => { $('pwSheet').removeEventListener('close', onClose); $('pwSheet').close(); resolve(v); };
    // the close event of a previous round can arrive late: only a real close (sheet not open) cancels
    const onClose = () => { if (!$('pwSheet').open) { $('pwSheet').removeEventListener('close', onClose); resolve(null); } };
    $('pwOpen').onclick = () => { const v = $('pwInput').value; if (v) done(v); else $('pwInput').focus(); };
    $('pwInput').onkeydown = (e) => { if (e.key === 'Enter') $('pwOpen').click(); };
    $('pwSheet').addEventListener('close', onClose);
    openSheet('pwSheet');
    setTimeout(() => $('pwInput').focus(), 60);
  });
}
$('pwShow').onclick = () => { const show = $('pwInput').type === 'password'; $('pwInput').type = show ? 'text' : 'password'; $('pwShow').setAttribute('aria-pressed', String(show)); };
$('dlPwShow').onclick = () => { const show = $('dlPw').type === 'password'; $('dlPw').type = show ? 'text' : 'password'; $('dlPwShow').setAttribute('aria-pressed', String(show)); };
$('dlPw').addEventListener('input', () => { if ($('dlPw').value.length >= 4) $('dlPwError').hidden = true; });
$('dlLock').addEventListener('change', () => { $('dlPwRow').hidden = !$('dlLock').checked; if ($('dlLock').checked) $('dlPw').focus(); });
function lockReady() {
  if (!$('dlLock').checked) return true;
  if ($('dlPw').value.length < 4) { $('dlPwError').hidden = false; $('dlPw').focus(); return false; }
  $('dlPwError').hidden = true;
  return true;
}

/* ---------- Intro tour ----------
   Shown once after the first document is opened, and again from the ⋯ menu. */
const TOUR = [
  { el: () => document.querySelector('.card:not(.add) .thumb'), title: 'העמודים שלך', text: 'הקשה על עמוד פותחת את כל הפעולות שלו: עריכה, סיבוב, חיתוך, עמוד ריק ועוד. לחיצה ארוכה בוחרת כמה עמודים יחד.' },
  { el: () => document.querySelector('.tab[data-tab="edit"]'), title: 'עריכה', text: 'כותבים ישר על הדף, משנים מילים שכבר קיימות במסמך, ומוחקים אזורים, כולל השחרה מאובטחת.' },
  { el: () => document.querySelector('.tab[data-tab="insert"]'), title: 'הוספה', text: 'חתימה, תמונה או לוגו, מרקר, צורות, תאריך ועמוד ריק.' },
  { el: () => document.querySelector('.tab[data-tab="tools"]'), title: 'כלים', text: 'סימן מים, מספרי עמודים, הקטנת קובץ, הוספת קבצים והפיכת תמונות לעמודים.' },
  { el: () => $('undoBtn'), title: 'ביטול ושמירה', text: 'טעית? ביטול פעולה. העבודה נשמרת במכשיר אוטומטית, גם אם סוגרים את האפליקציה.' },
  { el: () => $('downloadBtn'), title: 'סיימת?', text: 'הורדה או שיתוף לוואטסאפ ולמייל, עם אפשרות להקטין את הקובץ ולנעול אותו בסיסמה.' },
];
let tourStep = -1;
function startTour() { closeSheets(); if (edActive()) leaveEditor(); if (tourStep < 0) pushLayer('tour'); tourStep = 0; $('tour').hidden = false; showTourStep(); }
function endTour() { if (tourStep >= 0) popLayer('tour'); tourStep = -1; $('tour').hidden = true; prefs.tourDone = true; savePrefs(); }
function showTourStep() {
  const st = TOUR[tourStep], el = st && st.el();
  if (!st) { endTour(); return; }
  if (!el || !el.getBoundingClientRect().width) { tourStep++; showTourStep(); return; }
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect(), pad = 6;
  Object.assign($('tourHole').style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  $('tourTitle').textContent = st.title; $('tourText').textContent = st.text;
  $('tourCount').textContent = `${tourStep + 1} מתוך ${TOUR.length}`;
  $('tourNext').textContent = tourStep === TOUR.length - 1 ? 'סיום' : 'הבא';
  const card = $('tourCard'), ch = card.offsetHeight, below = r.bottom + 14 + ch < innerHeight - 8;
  card.style.top = (below ? r.bottom + 14 : Math.max(8, r.top - 14 - ch)) + 'px';
}
$('tourNext').onclick = () => { tourStep++; showTourStep(); };
$('tourSkip').onclick = endTour;
$('tourBtn').onclick = startTour;
window.addEventListener('resize', () => { if (tourStep >= 0) showTourStep(); });
function maybeTour() {
  // never pull the user out of the editor or a sheet they opened in the meantime
  if (!prefs.tourDone && state.pages.length && !edActive()) setTimeout(() => { if (tourStep < 0 && !edActive() && !selecting && !document.querySelector('dialog[open]')) startTour(); }, 900);
}

/* ---------- Saving work on the device ----------
   The original files, the pages with every change, pictures and settings are kept in the browser's
   storage on this device (IndexedDB). Nothing is sent anywhere. */
const store = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('mypdf', 1);
    r.onupgradeneeded = () => { for (const n of ['files', 'assets', 'session']) r.result.createObjectStore(n); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = (name, mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction(name, mode), req = fn(t.objectStore(name));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  const safe = (p) => p.catch(e => { console.warn('storage', e); return undefined; });
  return {
    get: (name, key) => safe(tx(name, 'readonly', s => s.get(key))),
    put: (name, key, val) => safe(tx(name, 'readwrite', s => s.put(val, key))),
    clear: (name) => safe(tx(name, 'readwrite', s => s.clear())),
  };
})();
const SETTING_IDS = ['wmOn', 'wmText', 'wmSize', 'wmColor', 'wmOpacity', 'wmAngle', 'pnOn', 'pnFmt', 'pnPos', 'pnSize', 'pnStart'];
let savedSig = '', saveState = 'saved', restoring = false;
function sessionData() {
  const used = new Set(state.pages.map(p => p.src));
  return {
    v: 1, at: Date.now(),
    fileName: $('fileName').value, fileNameAuto: $('fileName').dataset.auto !== 'no',
    sources: state.sources.map((s, i) => used.has(i) ? { key: s.key, name: s.name } : null),
    pages: state.pages,
    forms: state.forms,
    settings: Object.fromEntries(SETTING_IDS.map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value])),
    ui: uiState(),
  };
}
/* Where the user is: screen, page, editing mode, zoom and scroll position */
function uiState() {
  const editing = edActive() && ed.pid != null;
  return {
    view: editing ? 'edit' : 'pages', pid: editing ? ed.pid : null,
    mode: ['text', 'edit', 'erase'].includes(ed.mode) ? ed.mode : 'text',
    zoom: ed.zoom, sl: $('edBody').scrollLeft, st: $('edBody').scrollTop,
    gridTop: $('pagesView').scrollTop,
  };
}
async function restoreUi(ui) {
  if (!ui) return;
  if (ui.view === 'edit' && state.pages.some(p => p.id === ui.pid)) {
    await openEditor(ui.pid);
    if (ui.mode && ui.mode !== ed.mode) setMode(ui.mode);
    if (ui.zoom && ui.zoom !== ed.zoom) { ed.zoom = clampZoom(ui.zoom); layoutEditor(); scheduleRender(); }
    requestAnimationFrame(() => { $('edBody').scrollLeft = ui.sl || 0; $('edBody').scrollTop = ui.st || 0; positionFmtBar(); });
  } else requestAnimationFrame(() => { $('pagesView').scrollTop = ui.gridTop || 0; });
}
async function autosave(force) {
  if (restoring) return;
  const data = sessionData();
  const sig = JSON.stringify([data.fileName, data.sources, data.pages, data.settings, data.forms, data.ui.view, data.ui.pid, data.ui.mode]);
  if (sig === savedSig && force !== true) return;
  savedSig = sig;
  saveState = 'saving'; showSaveState();
  if (!state.pages.length) { persisted.clear(); await store.clear('session'); await store.clear('files'); await store.clear('assets'); }
  else {
    // files and pictures removed by "start over" come back with undo, so store anything missing again
    for (const i of new Set(state.pages.map(p => p.src))) { const src = state.sources[i]; if (src && !persisted.has(src.key)) { persisted.add(src.key); await store.put('files', src.key, src.bytes); } }
    for (const p of state.pages) for (const o of p.objs || []) if (!persisted.has(o.asset) && assets.has(o.asset)) { persisted.add(o.asset); await store.put('assets', o.asset, assets.get(o.asset)); }
    await store.put('session', 'current', data);
  }
  saveState = 'saved'; showSaveState();
}
function showSaveState() {
  const meta = $('docMeta'); if (!meta || !state.pages.length) return;
  meta.querySelector('.save-state')?.remove();
  const sp = document.createElement('span');
  sp.className = 'save-state' + (saveState === 'saving' ? ' busy' : '');
  sp.textContent = saveState === 'saving' ? ' · שומר…' : ' · נשמר ✓';
  meta.appendChild(sp);
}
setInterval(autosave, 1500);
// leaving the app: save everything now, including zoom and scroll position
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave(true); });
window.addEventListener('pagehide', () => autosave(true));
// ask the browser not to clear this storage when space runs low
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}

/* Resume card on the start screen */
let pendingSession = null;
async function checkSession() {
  const rec = await store.get('session', 'current');
  if (!rec || !rec.pages || !rec.pages.length || state.pages.length) return;
  pendingSession = rec;
  const mins = Math.round((Date.now() - rec.at) / 60000);
  const when = mins < 1 ? 'עכשיו' : mins < 60 ? `לפני ${mins} דקות` : mins < 1440 ? `לפני ${Math.round(mins / 60)} שעות` : `לפני ${Math.round(mins / 1440)} ימים`;
  $('resumeName').textContent = (rec.fileName || 'מסמך').replace(/\.pdf$/i, '');
  const at = rec.ui && rec.ui.view === 'edit' ? rec.pages.findIndex(p => p.id === rec.ui.pid) : -1;
  $('resumeMeta').textContent = `${pagesText(rec.pages.length)} · נשמר ${when}` + (at >= 0 ? ` · בעריכה, עמוד ${at + 1}` : '');
  $('resumeBtn').textContent = at >= 0 ? 'המשך עריכה' : 'המשך עבודה';
  $('resumeCard').hidden = false;
}
async function restoreSession(rec) {
  restoring = true;
  busy(true, 'פותח את המסמך ששמרת…');
  try {
    state.sources = []; state.pages = [];
    for (const meta of rec.sources) {
      if (!meta) { state.sources.push(null); continue; }
      const bytes = await store.get('files', meta.key);
      if (!bytes) throw new Error('missing file');
      state.sources.push({ name: meta.name, key: meta.key, bytes, pdf: await openPdf(bytes), cache: new Map() });
      persisted.add(meta.key);
    }
    for (const p of rec.pages) for (const o of p.objs || []) {
      if (!assets.has(o.asset)) { const d = await store.get('assets', o.asset); if (d) { assets.set(o.asset, d); persisted.add(o.asset); } }
    }
    state.forms = {};
    for (let i = 0; i < state.sources.length; i++) if (state.sources[i]) await loadFormFields(i);
    for (const [k, vals] of Object.entries(rec.forms || {})) state.forms[k] = Object.assign(state.forms[k] || {}, vals);
    state.pages = rec.pages.filter(p => state.sources[p.src]);
    let maxId = 0;
    const walk = (v) => { if (v && typeof v === 'object') { if (typeof v.id === 'number') maxId = Math.max(maxId, v.id); Object.values(v).forEach(walk); } };
    walk(state.pages);
    uid = maxId + 1;
    for (const [id, v] of Object.entries(rec.settings || {})) { const el = $(id); if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
    $('fileName').value = rec.fileName || 'מסמך.pdf';
    if (!rec.fileNameAuto) $('fileName').dataset.auto = 'no';
    history.length = 0; $('undoBtn').disabled = true;
    $('resumeCard').hidden = true; pendingSession = null;
    onSettings();
    renderGrid();
    await restoreUi(rec.ui);
    toast(rec.ui && rec.ui.view === 'edit' ? 'חזרת לעריכה בדיוק איפה שעצרת' : 'המסמך נפתח מאיפה שעצרת');
  } catch (e) {
    console.warn(e);
    state.sources = []; state.pages = [];
    toast('לא הצלחתי לפתוח את העבודה השמורה. אפשר לבחור את הקובץ מחדש.', 5000);
    $('resumeCard').hidden = true;
  } finally {
    restoring = false; savedSig = ''; busy(false);
  }
}
$('resumeBtn').onclick = () => pendingSession && restoreSession(pendingSession);
async function forgetSession() {
  pendingSession = null; $('resumeCard').hidden = true; persisted.clear();
  await store.clear('session'); await store.clear('files'); await store.clear('assets');
}
$('resumeDiscard').onclick = async () => { await forgetSession(); toast('העבודה השמורה נמחקה. אפשר לבחור קובץ חדש.'); };
checkSession();

/* ---------- App: offline support and installing to the home screen ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(e => console.warn('offline support unavailable', e)); });
}
let installEvent = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function showInstall(on) { $('installBtn').hidden = !on; $('installMenuBtn').hidden = !on; }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; showInstall(true); });
window.addEventListener('appinstalled', () => { installEvent = null; showInstall(false); toast('האפליקציה הותקנה. אפשר לפתוח אותה ממסך הבית.', 4000); });
async function promptInstall() {
  closeSheets();
  if (!installEvent) return;
  installEvent.prompt();
  try { await installEvent.userChoice; } catch (_) {}
  installEvent = null; showInstall(false);
}
$('installBtn').onclick = promptInstall;
$('installMenuBtn').onclick = promptInstall;
// iPhone and iPad have no install prompt: explain the Share menu instead
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone()) $('iosHint').hidden = false;

/* Test hook: the automated tests (tests/run.mjs) reach a few pure helpers when the page is opened with #selftest */
if (location.hash === '#selftest') window.__mypdf = { bidiRuns, isHebrew, paperName, pageNumberText, pagesText, looksLikePdf, escapeHtml, fieldSize };
})();
