/**
 * boot.js — the VR page's guard, a plain script loaded before the module.
 *
 * If the module or one of its imports (three.js among them) fails to load,
 * or the scene has not come up after a while, the page says so with a way
 * to try again, instead of staying a black screen. main.js sets
 * window.muninnVRStarted once the scene is up (or has failed and said so).
 */
(function guard() {
  var WAIT_MS = 25000;
  var lang = (new URLSearchParams(location.search).get('lang') || navigator.language || '').toLowerCase();
  var ru = lang.indexOf('ru') === 0;
  var words = ru
    ? { text: 'Страница VR не загрузилась: не удалось получить часть её кода.', again: 'Перезапустить сцену' }
    : { text: 'The VR page did not load: part of its code could not be fetched.', again: 'Restart the scene' };

  function say() {
    if (window.muninnVRStarted) return;
    var box = document.getElementById('vr-problem');
    if (!box) return;
    document.getElementById('vr-problem-text').textContent = words.text;
    var b = document.getElementById('vr-problem-do');
    b.textContent = words.again;
    b.hidden = false;
    b.onclick = function again() { location.reload(); };
    box.hidden = false;
  }

  // A script that fails to load (the module, or anything it imports) fires an error on its element.
  window.addEventListener('error', function onError(e) {
    var t = e.target;
    if (t && t.tagName === 'SCRIPT') say();
  }, true);
  setTimeout(say, WAIT_MS);
}());
