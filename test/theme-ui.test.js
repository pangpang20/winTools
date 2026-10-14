const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

test('titlebar switches dark and light themes and restores the saved choice', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
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
    const appearance = "({ theme: document.documentElement.dataset.theme, stored: localStorage.getItem('zhuomiantools.theme'), label: document.getElementById('themeToggle').getAttribute('aria-label'), text: document.getElementById('themeLabel').textContent, titlebar: getComputedStyle(document.querySelector('.titlebar')).backgroundColor, sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor, panel: getComputedStyle(document.querySelector('.settings-panel')).backgroundImage, portTable: getComputedStyle(document.querySelector('.port-table-wrap')).backgroundColor, error: getComputedStyle(document.querySelector('.port-error') || document.createElement('div')).color })";
    let state = await evaluate(appearance);
    assert.equal(state.theme, 'dark');
    assert.equal(state.label, '切换为浅色主题');
    assert.equal(state.text, '浅色');
    assert.match(state.titlebar, /rgba?\(11, 13, 18/);

    await evaluate("document.getElementById('themeToggle').click()");
    state = await evaluate(appearance);
    assert.equal(state.theme, 'light');
    assert.equal(state.stored, 'light');
    assert.equal(state.label, '切换为深色主题');
    assert.equal(state.text, '深色');
    assert.equal(state.sidebar, 'rgb(237, 243, 249)');
    assert.equal(state.portTable, 'rgb(255, 255, 255)');
    assert.match(state.panel, /rgb\(255, 255, 255\)/);
    if (process.env.THEME_SCREENSHOT) {
      const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(`${process.env.THEME_SCREENSHOT}.light.png`, Buffer.from(shot.data, 'base64'));
    }

    await call('Page.reload', { ignoreCache: true });
    await waitFor("document.readyState === 'complete' && document.getElementById('themeToggle')?.getAttribute('aria-label') === '切换为深色主题'");
    state = await evaluate(appearance);
    assert.equal(state.theme, 'light');
    assert.equal(state.stored, 'light');
    await evaluate("document.getElementById('themeToggle').click()");
    state = await evaluate(appearance);
    assert.equal(state.theme, 'dark');
    assert.equal(state.stored, 'dark');
    assert.equal(state.label, '切换为浅色主题');
  } finally {
    socket?.close();
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); }
    if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});
