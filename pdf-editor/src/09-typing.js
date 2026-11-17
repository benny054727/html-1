/* ---------- Typing directly on the page ----------
   The selected text turns into a text box drawn in the same font, size, colour and position, so
   the user types where the text is. The text field at the top stays in sync. */
function startInline(o, selectAll) {
  ed.selId = o.id; ed.selRect = null; ed.selObj = null; ed.inline = o.id;
  $('edText').value = o.text; growText();
  drawOverlays();
  const ta = $('stage').querySelector('.ov.inline textarea');
  if (!ta) return;
  ta.focus({ preventScroll: true });
  if (selectAll) ta.select(); else ta.setSelectionRange(ta.value.length, ta.value.length);
  setTimeout(keepTypingVisible, 350);           // after the keyboard has opened
}
function updateInline(o) {
  const stage = $('stage'), s = ed.scale;
  let el = stage.querySelector('.ov.inline');
  if (el && +el.dataset.id !== o.id) { el.remove(); el = null; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'ov inline sel'; el.dataset.id = o.id;
    const ta = document.createElement('textarea');
    ta.className = 'ov-edit'; ta.rows = 1; ta.spellcheck = false; ta.setAttribute('aria-label', 'הטקסט');
    ta.value = o.text;
    ta.addEventListener('input', onInlineInput);
    el.appendChild(ta);
    stage.appendChild(el);
  }
  const ta = el.querySelector('textarea');
  if (ta.value !== o.text) ta.value = o.text;
  const img = ovImg(o), lines = String(o.text || ' ').split('\n').length;
  const slack = o.size * 1.2;                          // room for the next letters while typing
  const lh = (o.lh || 1.2) * o.size;
  const rtl = isHebrew(o.text || '') || (!o.text && o.anchor !== 'l');
  const align = o.align || (rtl ? 'r' : 'l');
  Object.assign(ta.style, {
    fontFamily: fontStack(o.font), fontWeight: String(fontWeight(o.font, o.bold)), fontSize: o.size * s + 'px',
    lineHeight: lh * s + 'px', color: o.color, letterSpacing: (o.ls || 0) * o.size * s + 'px',
    fontStyle: o.it ? 'italic' : 'normal', textDecoration: [o.u ? 'underline' : '', o.st ? 'line-through' : ''].join(' ').trim() || 'none',
    textAlign: align === 'c' ? 'center' : align === 'r' ? 'right' : 'left', direction: rtl ? 'rtl' : 'ltr',
    background: o.hl || 'transparent', opacity: String(o.op ?? 1),
    paddingTop: Math.max(0, (o.size - (lh / 2 + o.size * 0.33))) * s + 'px', paddingLeft: img.padL * s + 'px', paddingRight: img.padR * s + 'px',
  });
  const w = img.w + slack, h = Math.max(img.h, lines * lh + o.size * 0.3);
  el.style.width = w * s + 'px'; el.style.height = h * s + 'px';
  // keep the start edge where it is: the box grows to the left in Hebrew, to the right otherwise
  let [cx, cy] = overlayCenter(o, ed.vp, ed.R);
  const a = ovAngle(o, ed.R) * Math.PI / 180;
  const grow = o.anchor === 'r' ? -1 : o.anchor === 'l' ? 1 : 0;
  const dx = grow * slack / 2 * s, dy = (h - img.h) / 2 * s;
  cx += dx * Math.cos(a) + dy * Math.sin(a); cy += -dx * Math.sin(a) + dy * Math.cos(a);
  el.style.left = cx + 'px'; el.style.top = cy + 'px';
  el.style.transform = `translate(-50%, -50%) rotate(${-ovAngle(o, ed.R)}deg)`;
}
function onInlineInput(e) {
  const p = edPage(), o = p && p.overlays.find(x => x.id === ed.inline); if (!o) return;
  beginBurst();
  // new text typed from an empty box keeps its starting edge in place
  if (o.fresh && !o.anchor && e.target.value) {
    const img = ovImg(o), [cx] = [o.px];
    o.anchor = isHebrew(e.target.value) ? 'r' : 'l';
    const half = (img.w / 2 - (o.anchor === 'l' ? img.padL : img.padR));
    const th = o.ang * Math.PI / 180;
    o.px = cx + (o.anchor === 'r' ? 1 : -1) * half * Math.cos(th);
    o.py = o.py + (o.anchor === 'r' ? 1 : -1) * half * Math.sin(th);
  }
  o.text = e.target.value;
  $('edText').value = o.text; growText();
  updateInline(o);
  positionFmtBar();
  keepTypingVisible();
}
/* The top field mirrors the selected text; once that text is let go, the field is cleared so the next tap starts fresh */
function releaseField(o) { if (o && $('edText').value === o.text) { $('edText').value = ''; growText(); } }
function finishInline() {
  if (typeof ed === 'undefined' || !ed.inline) return;
  const p = edPage(), o = p && p.overlays.find(x => x.id === ed.inline);
  ed.inline = null;
  $('stage').querySelector('.ov.inline')?.remove();
  if (o) {
    delete o.fresh;
    releaseField(o);
    if (!o.text.trim() && o.srcItem == null) { p.overlays = p.overlays.filter(x => x !== o); ed.selId = null; $('edText').value = ''; growText(); }
  }
  drawOverlays();
  renderGrid();
}
/* Toolbar buttons must not take the keyboard away from the text being typed */
['fmtBar', 'objBar'].forEach(id => $(id).addEventListener('mousedown', (e) => { if (!e.target.closest('input, select')) e.preventDefault(); }));

