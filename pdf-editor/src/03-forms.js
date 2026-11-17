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

