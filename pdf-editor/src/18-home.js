/* ---------- Home screen: "what would you like to do?" ---------- */
// A tile remembers what the user came to do, opens the file picker,
// and once the file is in, takes them straight to that tool.
$('startTiles').addEventListener('click', (e) => {
  const t = e.target.closest('[data-start]'); if (!t) return;
  const k = t.dataset.start;
  if (k === 'imgs') { startIntent = null; $('imgPagesInput').click(); return; }
  startIntent = k;
  $('fileInput').click();
});
async function runStartIntent(k, first, added) {
  if (!first) return false;
  switch (k) {
    case 'sign':
      await openEditor(first.id); setMode('text'); openSignature(); return true;
    case 'edit':
      await openEditor(first.id); setMode('edit'); toast('הקישו על הטקסט שרוצים לשנות', 3500); return true;
    case 'form': {
      const p = state.pages.find(pg => pageFields(pg).length);
      await openEditor((p || first).id); setMode('text');
      toast(p ? 'הקישו על שדה כדי למלא אותו' : 'אין בקובץ שדות למילוי. הקישו במקום הרצוי בעמוד וכתבו', 4500);
      return true;
    }
    case 'redact':
      prefs.erase = 'redact'; savePrefs();
      await openEditor(first.id); setMode('erase'); return true;
    case 'split':
      startSelecting(); toast('סמנו את העמודים שרוצים לשמור, ואז לחצו על הורדה', 4500); return true;
    case 'merge':
      toast(added > 1 ? 'גררו עמודים כדי לשנות את הסדר, ואז הורידו קובץ אחד' : 'להוספת קובץ נוסף לחצו על "הוספת קובץ" בסוף הרשימה', 4500);
      return true;
    case 'shrink':
      if ($('dlSize').value === 'none') $('dlSize').value = 'light';
      syncSizeNote(); $('downloadBtn').click(); return true;
    case 'lock':
      $('downloadBtn').click();
      $('dlLock').checked = true; $('dlLock').dispatchEvent(new Event('change'));
      return true;
  }
  return false;
}
$('aboutBtn').onclick = () => openSheet('aboutSheet');
$('aboutMenuBtn').onclick = () => openSheet('aboutSheet');
