/* ---------- Loading files ---------- */
async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) { toast('אפשר להוסיף רק קובצי PDF'); return; }
  busy(true, 'קורא את הקבצים…');
  let added = 0;
  const before = JSON.stringify(state.pages), firstNew = state.pages.length;
  for (const f of files) {
    try {
      if (f.size > MAX_FILE_BYTES) { toast(`"${f.name}" גדול מדי (מעל ${MAX_FILE_BYTES / 1024 / 1024} MB).`, 5000); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!looksLikePdf(bytes)) { toast(`"${f.name}" אינו קובץ PDF תקין.`, 5000); continue; }
      const open = await unlockIfNeeded(bytes, f.name);
      if (!open) continue;
      await addBytes(open, f.name);
      added++;
    } catch (e) {
      console.error(e);
      const msg = e && e.name === 'PasswordException' ? `לא הצלחתי לפתוח את "${f.name}" עם הסיסמה הזו.` : `לא הצלחתי לפתוח את "${f.name}". ייתכן שהקובץ פגום.`;
      toast(msg, 5000);
    }
  }
  const intent = startIntent; startIntent = null;
  busy(false);
  renderGrid();
  if (added) {
    history.push(before); $('undoBtn').disabled = false;
    if (!(intent && await runStartIntent(intent, state.pages[firstNew], added))) maybeTour();
  }
}
function openPdf(bytes) {
  return pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,          // never compile code from inside a PDF
    enableXfa: false,
    cMapUrl: 'vendor/cmaps/', cMapPacked: true,
    standardFontDataUrl: 'vendor/standard_fonts/',
  }).promise;
}
async function addSource(bytes, name) {
  const pdf = await openPdf(bytes);
  const src = state.sources.length;
  const key = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  state.sources.push({ name, bytes, pdf, cache: new Map(), key });
  persisted.add(key); store.put('files', key, bytes);
  return src;
}
/* A blank page the same size and direction as the page it follows */
async function insertBlank(afterId) {
  const ref = state.pages.find(p => p.id === afterId);
  let w = 595.28, h = 841.89;
  if (ref) { const pg = await getPage(ref.src, ref.idx); const v = pg.getViewport({ scale: 1, rotation: totalRot(pg, ref) }); w = v.width; h = v.height; }
  const doc = await PDFDocument.create(); doc.addPage([w, h]);
  const src = await addSource(await doc.save(), 'עמוד ריק');
  snapshot();
  const page = { id: uid++, src, idx: 0, rot: 0, overlays: [], rects: [], objs: [] };
  state.pages.splice(ref ? idxOf(afterId) + 1 : state.pages.length, 0, page);
  renderGrid();
  toast('נוסף עמוד ריק');
  return page;
}
async function addBytes(bytes, name) {
  const s0 = state.pages.length > 0;
  if (!s0 && pendingSession) await forgetSession();   // a new document replaces the saved one
  const src = await addSource(bytes, name), pdf = state.sources[src].pdf;
  for (let i = 0; i < pdf.numPages; i++) state.pages.push({ id: uid++, src, idx: i, rot: 0, overlays: [], rects: [], objs: [] });
  const nFields = await loadFormFields(src);
  if (nFields) setTimeout(() => toast(`נמצא טופס עם ${nFields} שדות. אפשר למלא אותם במסך העריכה.`, 4500), 400);
  if ($('fileName').dataset.auto !== 'no') {
    const merged = new Set(state.pages.map(p => p.src)).size > 1;
    if (!merged || !s0) $('fileName').value = name.replace(/\.pdf$/i, '') + (merged ? '-ממוזג' : '-ערוך') + '.pdf';
    else $('fileName').value = $('fileName').value.replace(/-ערוך\.pdf$/, '-ממוזג.pdf');
  }
}

async function makeSample() {
  busy(true, 'יוצר קובץ לדוגמה…');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const titles = ['Quarterly Report', 'Revenue by Region', 'Customer Survey', 'Appendix'];
  titles.forEach((t, i) => {
    const page = doc.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 0, y: 781, width: 595.28, height: 61, color: rgb(0.06, 0.42, 0.45) });
    page.drawText('SAMPLE DOCUMENT', { x: 48, y: 805, size: 14, font: bold, color: rgb(1, 1, 1) });
    page.drawText(t, { x: 48, y: 720, size: 30, font: bold, color: rgb(0.1, 0.13, 0.17) });
    for (let l = 0; l < 14; l++) {
      const w = 420 + ((l * 37 + i * 53) % 80);
      page.drawRectangle({ x: 48, y: 670 - l * 26, width: w, height: 8, color: rgb(0.85, 0.87, 0.9) });
    }
    if (i === 1) [120, 180, 90, 210].forEach((h, b) => page.drawRectangle({ x: 70 + b * 110, y: 120, width: 70, height: h, color: rgb(0.76 - b * 0.12, 0.26 + b * 0.1, 0.05 + b * 0.15) }));
    page.drawText(`Page ${i + 1}`, { x: 500, y: 40, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  });
  const bytes = await doc.save();
  const before = JSON.stringify(state.pages);
  await addBytes(bytes, 'דוגמה.pdf');
  history.push(before); $('undoBtn').disabled = false;
  busy(false);
  renderGrid();
  toast('נטען קובץ לדוגמה עם 4 עמודים');
  maybeTour();
}

