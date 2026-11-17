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

