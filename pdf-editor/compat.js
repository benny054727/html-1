/* Old browsers (before iOS 15.4 / Chrome 98) cannot run the app: say so clearly instead of showing a broken page.
   Written in old JavaScript on purpose, so even old browsers can read it. */
(function () {
  var ok = typeof window.HTMLDialogElement === 'function' && typeof window.structuredClone === 'function' &&
    typeof Array.prototype.at === 'function' && typeof Promise !== 'undefined' && window.CSS && CSS.supports && CSS.supports('aspect-ratio: 1');
  if (ok) return;
  window.__unsupported = true;
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var how = ios ? 'באייפון: הגדרות ← כללי ← עדכון תוכנה (צריך iOS 15.4 ומעלה).'
                : 'עדכנו את הדפדפן (Chrome, Safari, Edge או Firefox) לגרסה האחרונה.';
  document.addEventListener('DOMContentLoaded', function () {
    document.body.innerHTML = '<div class="unsupported"><div class="u-icon">📄</div><h1>עורך MY PDF צריך דפדפן חדש יותר</h1>' +
      '<p>הדפדפן במכשיר הזה ישן מדי בשביל האפליקציה.</p><p><b>' + how + '</b></p></div>';
  });
})();
