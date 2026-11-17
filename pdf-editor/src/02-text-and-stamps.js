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

