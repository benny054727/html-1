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
  // only step back over a step this app added: never out of the app, even if the count is off
  if (!(window.history.state && window.history.state.mypdf)) return;
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
  startIntent = null;
  addFiles(e.dataTransfer.files);
});

/* ---------- Top bar, tab bar, selection bar ---------- */
$('pickBtn').onclick = () => { startIntent = null; $('fileInput').click(); };
$('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('sampleBtn').onclick = () => { startIntent = null; makeSample(); };
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

