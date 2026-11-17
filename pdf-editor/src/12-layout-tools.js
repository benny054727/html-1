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

