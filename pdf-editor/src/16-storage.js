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

