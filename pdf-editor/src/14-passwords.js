/* ---------- Passwords ----------
   Locked files are opened with the password once, and a plain copy is kept (only on this device);
   a downloaded file can be locked with a password (AES-256). Both use a second build of the PDF
   library that knows encryption, loaded only when needed. */
let cryptLib = null;
function loadCrypt() {
  return cryptLib || (cryptLib = new Promise((res) => {
    const orig = window.PDFLib, sc = document.createElement('script');
    sc.src = 'vendor/pdf-lib-crypt.min.js';
    sc.onload = () => { const lib = window.PDFLib; window.PDFLib = orig; res(lib); };
    sc.onerror = () => { window.PDFLib = orig; cryptLib = null; res(null); };
    document.head.appendChild(sc);
  }));
}
async function decryptPdf(bytes, password) {
  const L = await loadCrypt(); if (!L) throw new Error('crypt unavailable');
  const src = await L.PDFDocument.load(bytes, { password });
  const out = await L.PDFDocument.create();
  (await out.copyPages(src, src.getPageIndices())).forEach(pg => out.addPage(pg));
  return out.save();
}
async function lockPdf(bytes, password) {
  const L = await loadCrypt(); if (!L) throw new Error('crypt unavailable');
  const d = await L.PDFDocument.load(bytes);
  const owner = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  d.encrypt({ userPassword: password, ownerPassword: owner,
    permissions: { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true } });
  return d.save();
}
async function unlockIfNeeded(bytes, name) {
  let encrypted = false;
  try { encrypted = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).isEncrypted; } catch (_) {}
  if (!encrypted) return bytes;
  try { return await decryptPdf(bytes, ''); } catch (_) {}      // only restricted (printing, copying), no password to open
  let wrong = false;
  for (;;) {
    busy(false);
    const pw = await askPassword(name, wrong);
    if (pw == null) return null;
    busy(true, 'פותח את הקובץ…');
    try { return await decryptPdf(bytes, pw); } catch (_) { wrong = true; }
  }
}
function askPassword(name, wrong) {
  return new Promise((resolve) => {
    $('pwName').textContent = name;
    $('pwError').hidden = !wrong;
    $('pwInput').value = ''; $('pwInput').type = 'password'; $('pwShow').setAttribute('aria-pressed', 'false');
    const done = (v) => { $('pwSheet').removeEventListener('close', onClose); $('pwSheet').close(); resolve(v); };
    // the close event of a previous round can arrive late: only a real close (sheet not open) cancels
    const onClose = () => { if (!$('pwSheet').open) { $('pwSheet').removeEventListener('close', onClose); resolve(null); } };
    $('pwOpen').onclick = () => { const v = $('pwInput').value; if (v) done(v); else $('pwInput').focus(); };
    $('pwInput').onkeydown = (e) => { if (e.key === 'Enter') $('pwOpen').click(); };
    $('pwSheet').addEventListener('close', onClose);
    openSheet('pwSheet');
    setTimeout(() => $('pwInput').focus(), 60);
  });
}
$('pwShow').onclick = () => { const show = $('pwInput').type === 'password'; $('pwInput').type = show ? 'text' : 'password'; $('pwShow').setAttribute('aria-pressed', String(show)); };
$('dlPwShow').onclick = () => { const show = $('dlPw').type === 'password'; $('dlPw').type = show ? 'text' : 'password'; $('dlPwShow').setAttribute('aria-pressed', String(show)); };
$('dlPw').addEventListener('input', () => { if ($('dlPw').value.length >= 4) $('dlPwError').hidden = true; });
$('dlLock').addEventListener('change', () => { $('dlPwRow').hidden = !$('dlLock').checked; if ($('dlLock').checked) $('dlPw').focus(); });
function lockReady() {
  if (!$('dlLock').checked) return true;
  if ($('dlPw').value.length < 4) { $('dlPwError').hidden = false; $('dlPw').focus(); return false; }
  $('dlPwError').hidden = true;
  return true;
}

