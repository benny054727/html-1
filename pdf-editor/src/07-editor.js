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
