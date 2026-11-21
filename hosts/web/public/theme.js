// Applies the saved theme before the first paint (account menu › Theme).
(function () {
  try {
    var t = localStorage.getItem('rackoon-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
