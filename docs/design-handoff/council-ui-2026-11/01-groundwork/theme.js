const saved = localStorage.getItem('council-ui-theme');
document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.addEventListener('DOMContentLoaded', () => {
  const button = document.querySelector('[data-theme-toggle]');
  const update = () => { if (button) button.textContent = document.documentElement.dataset.theme === 'light' ? 'Use dark theme' : 'Use light theme'; };
  button?.addEventListener('click', () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('council-ui-theme', document.documentElement.dataset.theme);
    update();
  });
  update();
});
