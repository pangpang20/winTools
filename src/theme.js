(() => {
  const storageKey = 'zhuomiantools.theme';
  const root = document.documentElement;
  let theme = 'dark';
  try {
    theme = localStorage.getItem(storageKey) === 'light' ? 'light' : 'dark';
  } catch { /* Storage can be disabled by the host. */ }

  function applyTheme(nextTheme) {
    theme = nextTheme;
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f4f7fb' : '#0b0d12';
    const button = document.getElementById('themeToggle');
    if (!button) return;
    const label = theme === 'light' ? '深色' : '浅色';
    button.setAttribute('aria-label', `切换为${label}主题`);
    button.title = `切换为${label}主题`;
    document.getElementById('themeIcon').textContent = theme === 'light' ? '☾' : '☀';
    document.getElementById('themeLabel').textContent = label;
  }

  applyTheme(theme);
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(theme);
    document.getElementById('themeToggle').addEventListener('click', () => {
      applyTheme(theme === 'dark' ? 'light' : 'dark');
      try { localStorage.setItem(storageKey, theme); } catch { /* Keep the current session usable. */ }
    });
  });
})();
