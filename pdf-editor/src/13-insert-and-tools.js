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
  catch (e) {
    if (e && e.name === 'AbortError') return;
    // the browser allows the share sheet only right after a tap; preparing the file took too long, so ask for one more tap
    offerFile(bytes, name);
  }
};

/* ---------- "Your file is ready" ----------
   Used on iPhone for every download, and anywhere a share was refused because it did not follow a tap.
   Both buttons act inside the user's tap, which is what iOS requires. */
let readyFile = null;
function offerFile(bytes, name, before) {
  readyFile = { bytes, name };
  $('readyName').textContent = name;
  $('readyMeta').textContent = before && before > bytes.length ? `${mb(before)} ← ${mb(bytes.length)}` : mb(bytes.length);
  $('readyShare').hidden = !canShareFiles;
  $('readyHint').hidden = !canShareFiles;
  $('readySave').classList.toggle('primary', !canShareFiles);
  openSheet('readySheet');
}
$('readyShare').onclick = async () => {
  if (!readyFile) return;
  const file = new File([readyFile.bytes], readyFile.name, { type: 'application/pdf' });
  try { await navigator.share({ files: [file], title: readyFile.name }); closeSheets(); }
  catch (e) { if (e && e.name !== 'AbortError') toast('השיתוף לא הצליח. אפשר לשמור את הקובץ במקום זאת.', 4000); }
};
$('readySave').onclick = () => {
  if (!readyFile) return;
  saveBytes(readyFile.bytes, readyFile.name);
  closeSheets();
  toast(IOS ? 'אם נפתחה תצוגה של הקובץ: לחצו על שיתוף ⬆ ואז "שמירה בקבצים".' : `הקובץ "${readyFile.name}" ירד`, 5000);
};

