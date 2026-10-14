const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

test('titlebar selects and restores five themes with keyboard and pointer controls', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-ui-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const executable = process.env.THEME_APP || require('electron');
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(temp, 'data')}`];
  if (!process.env.THEME_APP) args.unshift(path.join(__dirname, '..'));
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
  let socket;
  try {
    let tab;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page' && item.url.endsWith('/src/index.html')); } catch { /* starting */ }
      if (tab) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(tab, 'toolbox page is available');
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let nextId = 0;
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      function onMessage(event) {
        const reply = JSON.parse(event.data);
        if (reply.id !== id) return;
        socket.removeEventListener('message', onMessage);
        if (reply.error || reply.result?.exceptionDetails) reject(new Error(JSON.stringify(reply.error || reply.result.exceptionDetails)));
        else resolve(reply.result);
      }
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
    const waitFor = async (expression) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try { if (await evaluate(`Boolean(${expression})`)) return; } catch { /* navigation */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`wait for ${expression}`);
    };
    await waitFor("document.readyState === 'complete' && document.getElementById('themeToggle') && window.desktopAPI");
    const appearance = "({ theme: document.documentElement.dataset.theme, tone: document.documentElement.dataset.tone, stored: localStorage.getItem('zhuomiantools.theme'), label: document.getElementById('themeToggle').getAttribute('aria-label'), text: document.getElementById('themeLabel').textContent, expanded: document.getElementById('themeToggle').getAttribute('aria-expanded'), menuHidden: document.getElementById('themeMenu').hidden, background: getComputedStyle(document.body).backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor, panel: getComputedStyle(document.querySelector('.settings-panel')).backgroundImage, portTable: getComputedStyle(document.querySelector('.port-table-wrap')).backgroundColor, selected: [...document.querySelectorAll('[data-theme-option][aria-pressed=true]')].map(option => option.dataset.themeOption), meta: document.querySelector('meta[name=theme-color]').content })";
    let state = await evaluate(appearance);
    assert.equal(state.theme, 'dark');
    assert.equal(state.tone, 'dark');
    assert.equal(state.label, '选择主题，当前深夜');
    assert.equal(state.menuHidden, true);
    assert.deepEqual(state.selected, ['dark']);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-theme-option]')].map(option => option.textContent.trim().replace('✓', '').trim())"), ['深夜', '明亮', '森林', '珊瑚', '石墨']);

    await evaluate("document.getElementById('themeToggle').click()");
    assert.equal(await evaluate("document.getElementById('themeToggle').getAttribute('aria-expanded')"), 'true');
    assert.equal(await evaluate("document.activeElement.dataset.themeOption"), 'dark');
    await call('Emulation.setDeviceMetricsOverride', { width: 640, height: 480, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate("(() => { const menu = document.getElementById('themeMenu'); const r = menu.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.left + r.width / 2, r.top + 18)?.closest('.theme-option') !== null; })()"), true);
    if (process.env.THEME_SCREENSHOT) {
      fs.mkdirSync(path.dirname(process.env.THEME_SCREENSHOT), { recursive: true });
      const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(`${process.env.THEME_SCREENSHOT}.menu.png`, Buffer.from(shot.data, 'base64'));
    }
    await call('Emulation.clearDeviceMetricsOverride');
    await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
    assert.equal(await evaluate("document.activeElement.dataset.themeOption"), 'light');
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    assert.equal(await evaluate("document.getElementById('themeMenu').hidden && document.activeElement.id === 'themeToggle'"), true);

    const themes = [
      ['light', '明亮', '#f4f7fb', '#176898', 'rgb(237, 243, 249)'],
      ['forest', '森林', '#eaf4ec', '#23724c', 'rgb(220, 235, 221)'],
      ['coral', '珊瑚', '#fff0ef', '#a63e54', 'rgb(249, 223, 225)'],
      ['graphite', '石墨', '#e9edf0', '#455e6d', 'rgb(217, 225, 230)'],
      ['dark', '深夜', '#0b0d12', '#7dd3fc', 'rgba(13, 16, 23, 0.78)']
    ];
    for (const [id, label, background, accent, sidebar] of themes) {
      await evaluate(`document.getElementById('themeToggle').click(); document.querySelector('[data-theme-option=${id}]').click()`);
      state = await evaluate(appearance);
      assert.equal(state.theme, id);
      assert.equal(state.stored, id);
      assert.equal(state.text, label);
      assert.equal(state.label, `选择主题，当前${label}`);
      assert.equal(state.meta.toLowerCase(), background);
      assert.equal(state.accent.toLowerCase(), accent);
      assert.equal(state.sidebar, sidebar);
      assert.deepEqual(state.selected, [id]);
      assert.equal(state.menuHidden, true);
      assert.equal(state.expanded, 'false');
      if (id !== 'dark') {
        assert.equal(state.tone, 'light');
        assert.match(state.panel, /linear-gradient/);
      }
      if (process.env.THEME_SCREENSHOT) {
        fs.mkdirSync(path.dirname(process.env.THEME_SCREENSHOT), { recursive: true });
        const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.writeFileSync(`${process.env.THEME_SCREENSHOT}.${id}.png`, Buffer.from(shot.data, 'base64'));
      }
      await call('Page.reload', { ignoreCache: true });
      await waitFor(`document.readyState === 'complete' && document.documentElement.dataset.theme === '${id}' && document.getElementById('themeLabel')?.textContent === '${label}'`);
      assert.equal((await evaluate(appearance)).selected[0], id);
    }
    await evaluate("document.getElementById('themeToggle').click(); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    assert.equal(await evaluate("document.getElementById('themeMenu').hidden"), true);
    await evaluate("document.getElementById('themeToggle').click(); document.getElementById('minimizeButton').focus()");
    assert.equal(await evaluate("document.getElementById('themeMenu').hidden"), true);
    await evaluate("localStorage.setItem('zhuomiantools.theme', 'invalid')");
    await call('Page.reload', { ignoreCache: true });
    await waitFor("document.readyState === 'complete' && document.documentElement.dataset.theme === 'dark'");
  } finally {
    socket?.close();
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); }
    if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});
