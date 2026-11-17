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

