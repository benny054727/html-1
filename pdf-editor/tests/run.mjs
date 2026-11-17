// End-to-end tests for עורך MY PDF.
// BROWSER=webkit runs them in WebKit (the engine of Safari on iPhone) as an iPhone 14;
// the default is Chromium as a Pixel 7 (Android).
// Opens the app in headless Chromium, works with real PDFs (made during the test) and checks
// the PDFs that come out, using the PDF reader inside the app.
//   node tests/run.mjs            run everything
//   node tests/run.mjs redaction  run tests whose name contains "redaction"
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const { chromium, devices } = playwright;
const ENGINE = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium';
const DEVICE = ENGINE === 'webkit' ? devices['iPhone 14'] : devices['Pixel 7'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] || '';

/* ---------- tiny static server for the app ---------- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try { const body = await readFile(join(root, path.endsWith('/') ? path + 'index.html' : path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_APP = `http://127.0.0.1:${server.address().port}/index.html`;
const tmp = await mkdtemp(join(tmpdir(), 'mypdf-test-'));
const browser = await playwright[ENGINE].launch();
// test PDFs with Hebrew text are printed by Chromium (only Chromium can print to PDF)
const printer = ENGINE === 'chromium' ? browser : await chromium.launch();
console.log(`engine: ${ENGINE} (${ENGINE === 'webkit' ? 'iPhone 14' : 'Pixel 7'})`);

/* ---------- helpers ---------- */
let errors = [];
async function open(opts = {}) {
  const { hash, tour, ...ctxOpts } = opts;
  const ctx = await browser.newContext({ ...DEVICE, acceptDownloads: true, serviceWorkers: 'block', ...ctxOpts });
  const page = await ctx.newPage();
  // the intro tour is tested on its own; elsewhere it is marked as seen
  if (!opts.tour) await page.addInitScript(() => { try { localStorage.setItem('dafdaf.prefs', JSON.stringify({ tourDone: true })); } catch (_) {} });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL_APP + (opts.hash || ''));
  return { ctx, page };
}
async function load(page, ...files) {
  await page.setInputFiles('#fileInput', files);
  await page.waitForSelector('.card canvas');
  await page.waitForTimeout(400);
}
async function toEditor(page) {
  await page.click('.tab[data-tab="edit"]');
  await page.waitForSelector('#stage canvas');
  await page.waitForTimeout(300);
}
async function download(page, { size = 'none', lock = '', secure = false } = {}) {
  if (await page.isVisible('.tab[data-tab="pages"]')) await page.click('.tab[data-tab="pages"]');
  await page.click('#downloadBtn');
  await page.selectOption('#dlSize', size);
  if (lock) { await page.check('#dlLock'); await page.fill('#dlPw', lock); } else await page.uncheck('#dlLock');
  if (await page.isVisible('#dlSecureRow')) { if (secure) await page.check('#dlSecure'); else await page.uncheck('#dlSecure'); }
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#dlAllBtn')]);
  const file = join(tmp, `out-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  await d.saveAs(file);
  return file;
}
/* Read a PDF with the app's own pdf.js: number of pages and the text of every page */
async function readPdf(page, file, password) {
  const b64 = (await readFile(file)).toString('base64');
  return page.evaluate(async ({ b64, password }) => {
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const size = data.length;            // pdf.js takes the buffer over to its worker, so measure first
    const doc = await pdfjsLib.getDocument({ data, password, isEvalSupported: false }).promise;
    const texts = [];
    for (let i = 1; i <= doc.numPages; i++) texts.push((await (await doc.getPage(i)).getTextContent()).items.map(it => it.str).join(' '));
    return { pages: doc.numPages, text: texts.join('\n'), size };
  }, { b64, password });
}
/* Test PDFs: Hebrew text made by Chromium, everything else with the app's pdf-lib */
async function hebrewPdf(html, name) {
  const pg = await printer.newPage();
  await pg.setContent(`<html dir="rtl"><body style="font-family:Arial;font-size:16px;padding:40px">${html}</body></html>`);
  const file = join(tmp, name); await pg.pdf({ path: file, format: 'A4' }); await pg.close();
  return file;
}
async function makePdf(page, fn, name) {
  const b64 = await page.evaluate(fn);
  const file = join(tmp, name); await writeFile(file, Buffer.from(b64, 'base64'));
  return file;
}
const toB64 = 'const u8 = await doc.save(); let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s);';
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const norm = (t) => t.replace(/\s+/g, ' ');

/* ---------- tests ---------- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('build: app.js matches the source files', async () => {
  execFileSync(process.execPath, [join(root, 'tools/build.mjs'), '--check'], { stdio: 'pipe' });
});

test('helpers: bidi order, paper sizes, page numbers', async () => {
  const { ctx, page } = await open({ hash: '#selftest' });
  const r = await page.evaluate(() => {
    const t = window.__mypdf;
    const vis = (s) => t.bidiRuns(s, t.isHebrew(s)).map(r => r.d + ':' + r.c.join('')).join(' | ');
    return {
      mixed: vis('שלום 123 ABC'), money: vis('מחיר ₪50'), date: vis('תאריך 05/06/2024'),
      a4: t.paperName(595.28, 841.89), pn: t.pageNumberText('he', 3, 12), one: t.pagesText(1),
      pdf: t.looksLikePdf(new TextEncoder().encode('%PDF-1.7 ...')), notPdf: t.looksLikePdf(new TextEncoder().encode('hello')),
    };
  });
  assert(r.mixed === 'L:ABC | R:  | L:123 | R:שלום ', 'mixed line order: ' + r.mixed);
  assert(r.money.startsWith('L:₪50'), 'currency stays with the number: ' + r.money);
  assert(r.date.startsWith('L:05/06/2024'), 'date stays together: ' + r.date);
  assert(r.a4.startsWith('A4'), 'A4 detected: ' + r.a4);
  assert(r.pn === 'עמוד 3 מתוך 12' && r.one === 'עמוד אחד', 'page texts');
  assert(r.pdf && !r.notPdf, 'PDF check');
  await ctx.close();
});

test('start: sample file, intro tour, page actions and blank page', async () => {
  const { ctx, page } = await open({ tour: true });
  await page.click('#sampleBtn'); await page.waitForSelector('.card canvas');
  await page.waitForSelector('#tour:not([hidden])', { timeout: 4000 });
  for (let i = 0; i < 6; i++) await page.click('#tourNext');
  assert(!(await page.isVisible('#tour')), 'tour closes after the last step');
  assert(await page.$$eval('.card:not(.add)', e => e.length) === 4, 'sample has 4 pages');
  await page.click('.card:nth-child(2) .thumb'); await page.click('#pageSheet [data-act="rotr"]');
  await page.click('.card:nth-child(1) .thumb'); await page.click('#pageSheet [data-act="blank"]'); await page.waitForTimeout(500);
  assert(await page.$$eval('.card:not(.add)', e => e.length) === 5, 'blank page added');
  const out = await readPdf(page, await download(page));
  assert(out.pages === 5, 'exported 5 pages, got ' + out.pages);
  await ctx.close();
});

test('text: Hebrew typed on the page is real text in the PDF', async () => {
  const file = await hebrewPdf('<h2>סיכום פגישה</h2><p>המשתתפים: דנה, יוסי ורון</p>', 'heb.pdf');
  const { ctx, page } = await open();
  await load(page, file); await toEditor(page);
  const st = await page.locator('#stage').boundingBox();
  await page.touchscreen.tap(st.x + st.width * 0.6, st.y + 300);
  await page.keyboard.type('שלום עולם 2025');
  await page.click('#fbBold');
  await page.touchscreen.tap(st.x + 20, st.y + 230);
  const out = await readPdf(page, await download(page));
  assert(norm(out.text).includes('ש ל ו ם') || norm(out.text).includes('שלום'), 'new text is extractable: ' + out.text);
  await ctx.close();
});

test('change: one word in a line, even when stored letter by letter', async () => {
  const split = (w) => [...w].map(c => `<span style="display:inline-block">${c}</span>`).join('');
  const file = await hebrewPdf(`<p>${split('שלום')} ${split('לכם')}, קוראים לי דני ${split('כהן')}</p><p>שם הלקוח: ישראל ישראלי מספר 48213</p>`, 'split.pdf');
  const { ctx, page } = await open();
  await load(page, file); await toEditor(page);
  await page.click('#edModes [data-mode=edit]'); await page.click('#unitSeg [data-unit="word"]');
  const words = await page.$$eval('.ti', e => e.map(x => x.title));
  assert(words.includes('שלום') && words.includes('48213') && words.includes('ישראלי'), 'words found: ' + words.join(','));
  await page.click('.ti[title="ישראלי"]'); await page.keyboard.type('כהן');
  await page.touchscreen.tap(20, 600);
  const out = await readPdf(page, await download(page, { secure: true }));
  assert(!out.text.includes('ישראלי'), 'old word removed with secure delete');
  await ctx.close();
});

test('redaction: text under a secure black box is gone from the file', async () => {
  const file = await hebrewPdf('<p>Secret account 123456</p><p>Public line</p>', 'secret.pdf');
  const { ctx, page } = await open();
  await load(page, file); await toEditor(page);
  await page.click('#edModes [data-mode=erase]'); await page.click('#eraseSeg [data-erase="redact"]');
  const box = await page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; });
  await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await page.mouse.move(box.x + box.w - 5, box.y + 60, { steps: 4 }); await page.mouse.up();
  const out = await readPdf(page, await download(page));
  assert(!out.text.includes('Secret') && !out.text.includes('123456'), 'redacted text removed: ' + out.text);
  await ctx.close();
});

test('forms: fields are found, filled in Hebrew and exported', async () => {
  const { ctx, page } = await open();
  const file = await makePdf(page, new Function(`return (async () => {
    const { PDFDocument } = PDFLib; const doc = await PDFDocument.create(); const p = doc.addPage([595, 842]); const f = doc.getForm();
    f.createTextField('name').addToPage(p, { x: 200, y: 700, width: 300, height: 22 });
    f.createCheckBox('agree').addToPage(p, { x: 200, y: 650, width: 18, height: 18 });
    const c = f.createDropdown('city'); c.addOptions(['Haifa', 'Eilat']); c.addToPage(p, { x: 200, y: 600, width: 160, height: 22 });
    ${toB64} })()`), 'form.pdf');
  await load(page, file); await toEditor(page);
  assert(await page.$$eval('.ff', e => e.length) === 3, 'three fields');
  await page.fill('.ff[title="name"]', 'ישראל ישראלי'); await page.click('.ff[title="agree"]'); await page.selectOption('.ff[title="city"]', 'Eilat');
  const out = await readPdf(page, await download(page));
  assert(out.text.includes('Eilat'), 'dropdown value exported');
  assert(/ישראל|ש ר א/.test(out.text), 'Hebrew value exported: ' + out.text);
  await ctx.close();
});

test('compress: photos get smaller and text stays text', async () => {
  const { ctx, page } = await open();
  const file = await makePdf(page, new Function(`return (async () => {
    const { PDFDocument, StandardFonts } = PDFLib; const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const c = document.createElement('canvas'); c.width = 2600; c.height = 1800; const x = c.getContext('2d');
    for (let i = 0; i < 3000; i++) { x.fillStyle = 'hsl(' + (i * 37 % 360) + ',70%,' + (30 + i % 40) + '%)'; x.fillRect((i * 97) % 2600, (i * 61) % 1800, 60, 60); }
    const img = await doc.embedJpg(c.toDataURL('image/jpeg', 0.95));
    const p = doc.addPage([842, 595]); p.drawImage(img, { x: 0, y: 0, width: 842, height: 595 }); p.drawText('Keep this text', { x: 40, y: 40, size: 18, font });
    ${toB64} })()`), 'photo.pdf');
  await load(page, file);
  const plain = await readPdf(page, await download(page, { size: 'none' }));
  const small = await readPdf(page, await download(page, { size: 'strong' }));
  assert(small.size < plain.size * 0.8, `smaller file (${plain.size} -> ${small.size})`);
  assert(small.text.includes('Keep this text'), 'text kept');
  await ctx.close();
});

test('passwords: lock on download, then open the locked file', async () => {
  const file = await hebrewPdf('<p>Locked content here</p>', 'plain.pdf');
  const { ctx, page } = await open();
  await load(page, file);
  const locked = await download(page, { lock: 'secret99' });
  let refused = false;
  try { await readPdf(page, locked); } catch { refused = true; }
  assert(refused, 'locked file does not open without the password');
  assert((await readPdf(page, locked, 'secret99')).text.includes('Locked content'), 'opens with the password');
  const { ctx: c2, page: p2 } = await open();
  await p2.setInputFiles('#fileInput', locked);
  await p2.waitForSelector('#pwSheet[open]'); await p2.fill('#pwInput', 'wrong'); await p2.click('#pwOpen');
  await p2.waitForTimeout(400); assert(await p2.isVisible('#pwError'), 'wrong password is reported');
  await p2.fill('#pwInput', 'secret99'); await p2.click('#pwOpen'); await p2.waitForSelector('.card canvas');
  await c2.close(); await ctx.close();
});

test('autosave: work comes back after closing the app', async () => {
  const file = await hebrewPdf('<p>Autosave check</p>', 'auto.pdf');
  const { ctx, page } = await open();
  await load(page, file); await toEditor(page);
  const st = await page.locator('#stage').boundingBox();
  await page.touchscreen.tap(st.x + st.width * 0.5, st.y + 300); await page.keyboard.type('נשמר');
  await page.touchscreen.tap(st.x + 20, st.y + 230);
  await page.click('.tab[data-tab="pages"]'); await page.waitForTimeout(2500);
  await page.close();
  const p2 = await ctx.newPage(); await p2.goto(URL_APP); await p2.waitForTimeout(600);
  assert(await p2.isVisible('#resumeCard'), 'resume card shown');
  await p2.click('#resumeBtn'); await p2.waitForSelector('.card canvas');
  const out = await readPdf(p2, await download(p2));
  assert(/נשמר|ר מ ש נ|נ ש מ ר/.test(out.text), 'restored text exported: ' + out.text);
  await ctx.close();
});

test('back button: closes the top layer and never leaves the app from the editor', async () => {
  const { ctx, page } = await open();
  await page.click('#sampleBtn'); await page.waitForSelector('.card canvas'); await page.waitForTimeout(300);
  const back = async () => { await page.evaluate(() => history.back()); await page.waitForTimeout(350); };
  await page.click('.card:nth-child(2) .thumb'); await page.click('#pageSheet [data-act="edit"]'); await page.waitForSelector('#stage canvas');
  await page.click('#downloadBtn'); await page.waitForSelector('#dlSheet[open]');
  await back();
  assert(!(await page.isVisible('#dlSheet[open]')) && await page.isVisible('#editView'), 'back closes the sheet and stays in the editor');
  await page.click('.tab[data-tab="insert"]'); await page.waitForSelector('#insertSheet[open]');
  await page.click('#insertSheet [data-close]'); await page.waitForTimeout(200);     // closed on screen: no extra step left behind
  await back();
  assert(await page.isVisible('#pagesView') && !(await page.isVisible('#editView')), 'back leaves the editor to the pages');
  assert(await page.isVisible('#app') && page.url().includes('index.html'), 'still in the app');
  // choosing pages
  const bb = await page.locator('.card:nth-child(1) .thumb').boundingBox();
  await page.mouse.move(bb.x + 20, bb.y + 20); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
  assert(await page.isVisible('#selbar'), 'selection started');
  await back();
  assert(!(await page.isVisible('#selbar')) && await page.isVisible('#tabbar'), 'back ends the selection');
  // into the editor with the tab, out with the tab, then back must not bring the editor back
  await page.click('.tab[data-tab="edit"]'); await page.waitForSelector('#stage canvas');
  await page.click('.tab[data-tab="pages"]'); await page.waitForTimeout(400);
  assert(await page.isVisible('#pagesView'), 'pages after the tab');
  await ctx.close();
});

test('resume: "continue" returns to the same page, mode and zoom in the editor', async () => {
  const { ctx, page } = await open();
  await page.click('#sampleBtn'); await page.waitForSelector('.card canvas'); await page.waitForTimeout(300);
  await page.click('.card:nth-child(3) .thumb'); await page.click('#pageSheet [data-act="edit"]'); await page.waitForSelector('#stage canvas');
  await page.click('#edModes [data-mode=erase]');
  await page.click('#zoomIn'); await page.click('#zoomIn'); await page.waitForTimeout(300);
  const zoom = await page.textContent('#zoomLabel');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));       // what the phone does when the app is left
  await page.waitForTimeout(1200);
  await page.close();
  const p2 = await ctx.newPage(); await p2.goto(URL_APP); await p2.waitForTimeout(600);
  const meta = await p2.textContent('#resumeMeta');
  assert(meta.includes('בעריכה, עמוד 3'), 'card says where the user was: ' + meta);
  assert((await p2.textContent('#resumeBtn')).includes('המשך עריכה'), 'button says continue editing');
  await p2.click('#resumeBtn'); await p2.waitForSelector('#stage canvas'); await p2.waitForTimeout(500);
  assert(await p2.isVisible('#editView'), 'back in the editor');
  assert((await p2.textContent('#edTitle')).includes('עמוד 3'), 'same page: ' + await p2.textContent('#edTitle'));
  assert(await p2.getAttribute('#edModes [data-mode=erase]', 'aria-pressed') === 'true', 'same mode (erase)');
  assert(await p2.textContent('#zoomLabel') === zoom, `same zoom (${zoom})`);
  await p2.evaluate(() => history.back()); await p2.waitForTimeout(400);
  assert(await p2.isVisible('#pagesView'), 'back from the restored editor goes to the pages');
  await ctx.close();
});

/* ---------- run ---------- */
let failed = 0;
for (const t of tests.filter(t => t.name.includes(only))) {
  errors = [];
  const t0 = Date.now();
  try {
    await t.fn();
    if (errors.length) throw new Error('browser errors:\n    ' + errors.join('\n    '));
    console.log(`✓ ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) { failed++; console.log(`✗ ${t.name}\n    ${e.message}`); }
}
await browser.close(); if (printer !== browser) await printer.close(); server.close();
console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
