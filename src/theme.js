(() => {
  const storageKey = 'zhuomiantools.theme';
  const root = document.documentElement;
  const themes = {
    dark: { label: '深夜', background: '#0b0d12', accent: '#7dd3fc' },
    light: { label: '明亮', background: '#f4f7fb', accent: '#176898' },
    forest: { label: '森林', background: '#eaf4ec', accent: '#23724c' },
    coral: { label: '珊瑚', background: '#fff0ef', accent: '#a63e54' },
    graphite: { label: '石墨', background: '#e9edf0', accent: '#455e6d' }
  };
  let theme = 'dark';
  try {
    const stored = localStorage.getItem(storageKey);
    if (Object.hasOwn(themes, stored)) theme = stored;
  } catch { /* Storage can be disabled by the host. */ }

  function applyTheme(nextTheme) {
    if (!Object.hasOwn(themes, nextTheme)) return;
    theme = nextTheme;
    root.dataset.theme = theme;
    root.dataset.tone = theme === 'dark' ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = themes[theme].background;
    const button = document.getElementById('themeToggle');
    if (!button) return;
    button.setAttribute('aria-label', `选择主题，当前${themes[theme].label}`);
    document.getElementById('themeLabel').textContent = themes[theme].label;
    document.getElementById('themeIcon').style.backgroundColor = themes[theme].accent;
    document.querySelectorAll('[data-theme-option]').forEach((option) => {
      option.setAttribute('aria-pressed', String(option.dataset.themeOption === theme));
    });
  }

  applyTheme(theme);
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(theme);
    const picker = document.getElementById('themePicker');
    const toggle = document.getElementById('themeToggle');
    const menu = document.getElementById('themeMenu');
    const options = [...menu.querySelectorAll('[data-theme-option]')];
    function closeMenu(restoreFocus = false) {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    }
    toggle.addEventListener('click', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) options.find((option) => option.dataset.themeOption === theme).focus();
    });
    options.forEach((option, index) => {
      option.addEventListener('click', () => {
        applyTheme(option.dataset.themeOption);
        try { localStorage.setItem(storageKey, theme); } catch { /* Keep the current session usable. */ }
        closeMenu(true);
      });
      option.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !menu.hidden) closeMenu(true);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!picker.contains(event.target) && !menu.hidden) closeMenu();
    });
    document.addEventListener('focusin', (event) => {
      if (!picker.contains(event.target) && !menu.hidden) closeMenu();
    });
  });
})();
