// Highlights the heading of the section being read in the post outline (.toc).
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  var targets = links.map(function (a) {
    return document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
  });
  if (!links.length) return;

  function update() {
    // The current section is the last heading that has scrolled past the top area.
    var current = 0;
    for (var i = 0; i < targets.length; i++) {
      if (targets[i] && targets[i].getBoundingClientRect().top < 120) current = i;
    }
    // At the very bottom, the last heading may never reach the top: select it anyway.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      current = targets.length - 1;
    }
    links.forEach(function (a, i) { a.classList.toggle('active', i === current); });
  }

  var queued = false;
  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; update(); });
  }, { passive: true });
  update();
})();
