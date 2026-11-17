/* ---------- Intro tour ----------
   Shown once after the first document is opened, and again from the ⋯ menu. */
const TOUR = [
  { el: () => document.querySelector('.card:not(.add) .thumb'), title: 'העמודים שלך', text: 'הקשה על עמוד פותחת את כל הפעולות שלו: עריכה, סיבוב, חיתוך, עמוד ריק ועוד. לחיצה ארוכה בוחרת כמה עמודים יחד.' },
  { el: () => document.querySelector('.tab[data-tab="edit"]'), title: 'עריכה', text: 'כותבים ישר על הדף, משנים מילים שכבר קיימות במסמך, ומוחקים אזורים, כולל השחרה מאובטחת.' },
  { el: () => document.querySelector('.tab[data-tab="insert"]'), title: 'הוספה', text: 'חתימה, תמונה או לוגו, מרקר, צורות, תאריך ועמוד ריק.' },
  { el: () => document.querySelector('.tab[data-tab="tools"]'), title: 'כלים', text: 'סימן מים, מספרי עמודים, הקטנת קובץ, הוספת קבצים והפיכת תמונות לעמודים.' },
  { el: () => $('undoBtn'), title: 'ביטול ושמירה', text: 'טעית? ביטול פעולה. העבודה נשמרת במכשיר אוטומטית, גם אם סוגרים את האפליקציה.' },
  { el: () => $('downloadBtn'), title: 'סיימת?', text: 'הורדה או שיתוף לוואטסאפ ולמייל, עם אפשרות להקטין את הקובץ ולנעול אותו בסיסמה.' },
];
let tourStep = -1;
function startTour() { closeSheets(); if (edActive()) leaveEditor(); tourStep = 0; $('tour').hidden = false; showTourStep(); }
function endTour() { tourStep = -1; $('tour').hidden = true; prefs.tourDone = true; savePrefs(); }
function showTourStep() {
  const st = TOUR[tourStep], el = st && st.el();
  if (!st) { endTour(); return; }
  if (!el || !el.getBoundingClientRect().width) { tourStep++; showTourStep(); return; }
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect(), pad = 6;
  Object.assign($('tourHole').style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  $('tourTitle').textContent = st.title; $('tourText').textContent = st.text;
  $('tourCount').textContent = `${tourStep + 1} מתוך ${TOUR.length}`;
  $('tourNext').textContent = tourStep === TOUR.length - 1 ? 'סיום' : 'הבא';
  const card = $('tourCard'), ch = card.offsetHeight, below = r.bottom + 14 + ch < innerHeight - 8;
  card.style.top = (below ? r.bottom + 14 : Math.max(8, r.top - 14 - ch)) + 'px';
}
$('tourNext').onclick = () => { tourStep++; showTourStep(); };
$('tourSkip').onclick = endTour;
$('tourBtn').onclick = startTour;
window.addEventListener('resize', () => { if (tourStep >= 0) showTourStep(); });
function maybeTour() {
  // never pull the user out of the editor or a sheet they opened in the meantime
  if (!prefs.tourDone && state.pages.length && !edActive()) setTimeout(() => { if (tourStep < 0 && !edActive() && !selecting && !document.querySelector('dialog[open]')) startTour(); }, 900);
}

