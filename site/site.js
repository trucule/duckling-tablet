// Back to top: a button that appears once the reader has scrolled past the first screen.
(function () {
  var b = document.createElement('a');
  b.href = '#';
  b.className = 'to-top';
  b.textContent = 'Back to top';
  b.addEventListener('click', function (e) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); history.replaceState(null, '', location.pathname + location.search); });
  document.body.appendChild(b);
  function update() { b.classList.toggle('shown', window.scrollY > window.innerHeight * 0.8); }
  window.addEventListener('scroll', update, { passive: true });
  update();
})();
