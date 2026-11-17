const $ = (id) => document.getElementById(id);
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const { PDFDocument, degrees, rgb, StandardFonts } = PDFLib;

const SRC_COLORS = ['#0f6c72', '#c2410c', '#7c3aed', '#15803d', '#be185d', '#1d4ed8', '#a16207'];
const MAX_FILE_BYTES = 200 * 1024 * 1024;
function looksLikePdf(bytes) {
  // A PDF starts with "%PDF-" within its first 1024 bytes
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}
const UI_FONT = 'Heebo, "Segoe UI", Arial, sans-serif';

/* ---------- State ---------- */
const state = {
  sources: [],   // {name, bytes, pdf, cache: Map}
  pages: [],     // {id, src, idx, rot, overlays:[{id,text,size,color,bold,px,py,ang}]}
  selected: new Set(),
  fields: {},    // source index -> Map(page index -> [form fields])
  forms: {},     // source index -> { field name: value }
};
let uid = 1;
const persisted = new Set();   // keys of files and pictures already in device storage
const history = [];
const thumbCache = new Map(); // page id -> {key, canvas}

function snapshot() {
  history.push(JSON.stringify(state.pages));
  if (history.length > 60) history.shift();
  $('undoBtn').disabled = false;
}
function undo() {
  if (!history.length) return;
  state.pages = JSON.parse(history.pop());
  const ids = new Set(state.pages.map(p => p.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  $('undoBtn').disabled = !history.length;
  renderGrid();
  if (edActive()) { ed.inline = null; $('stage').querySelector('.ov.inline')?.remove(); if (!edPage()) leaveEditor(); else { ed.selId = null; drawEditor(); } }
  toast('הפעולה בוטלה');
}

/* ---------- Settings ---------- */
function settings() {
  return {
    wm: { on: $('wmOn').checked, text: $('wmText').value, size: +$('wmSize').value || 72, color: $('wmColor').value,
          opacity: +$('wmOpacity').value / 100, angle: +$('wmAngle').value },
    pn: { on: $('pnOn').checked, fmt: $('pnFmt').value, pos: $('pnPos').value, size: +$('pnSize').value || 11,
          start: Number.isFinite(+$('pnStart').value) ? +$('pnStart').value : 1 },
  };
}

