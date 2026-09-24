// Dark is the default theme (see sass/_theme.scss). The visitor's choice is remembered.
(function () {
  var KEY = 'theme';
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function save(value) {
    try { localStorage.setItem(KEY, value); } catch (e) {}
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
  }

  // Runs in <head> before first paint to avoid a flash of the wrong theme.
  apply(stored() === 'light' ? 'light' : 'dark');

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    function label() {
      btn.textContent = root.getAttribute('data-theme') === 'light' ? 'Dark' : 'Light';
    }
    label();
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      apply(next);
      save(next);
      label();
    });
  });
})();
