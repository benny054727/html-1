/* ---------- App: offline support and installing to the home screen ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(e => console.warn('offline support unavailable', e)); });
}
let installEvent = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function showInstall(on) { $('installBtn').hidden = !on; $('installMenuBtn').hidden = !on; }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; showInstall(true); });
window.addEventListener('appinstalled', () => { installEvent = null; showInstall(false); toast('האפליקציה הותקנה. אפשר לפתוח אותה ממסך הבית.', 4000); });
async function promptInstall() {
  closeSheets();
  if (!installEvent) return;
  installEvent.prompt();
  try { await installEvent.userChoice; } catch (_) {}
  installEvent = null; showInstall(false);
}
$('installBtn').onclick = promptInstall;
$('installMenuBtn').onclick = promptInstall;
// iPhone and iPad have no install prompt: explain the Share menu instead
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone()) $('iosHint').hidden = false;

/* Test hook: the automated tests (tests/run.mjs) reach a few pure helpers when the page is opened with #selftest */
if (location.hash === '#selftest') window.__mypdf = { bidiRuns, isHebrew, paperName, pageNumberText, pagesText, looksLikePdf, escapeHtml, fieldSize };
