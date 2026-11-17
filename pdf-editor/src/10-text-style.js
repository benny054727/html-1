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

