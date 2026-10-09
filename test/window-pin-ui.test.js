const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function debuggerTab(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const tabs = await response.json();
      const tab = tabs.find((item) => item.type === 'page' && item.url.endsWith('/src/index.html'));
      if (tab) return tab;
    } catch { /* app is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('未找到工具箱界面调试页');
}

test('window thumbnail opens and closes enlarged preview', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'window-pin-ui-'));
  const port = await freePort();
  const executable = process.env.WINDOW_PIN_APP || require('electron');
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
  if (!process.env.WINDOW_PIN_APP) args.unshift(path.join(__dirname, '..'));
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
  let socket;
  try {
    const tab = await debuggerTab(port);
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let nextId = 0;
    const call = (method, params) => new Promise((resolve, reject) => {
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
    const ready = await evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.desktopAPI && typeof renderExternalWindows === 'function' && document.querySelector('[data-tool="windowPin"]')) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > 10000) { clearInterval(timer); resolve(false); }
      }, 100);
    })`);
    assert.equal(ready, true, `toolbox page is ready: ${JSON.stringify(await evaluate("({ url: location.href, state: document.readyState, title: document.title, nav: !!document.querySelector('[data-tool=windowPin]'), api: typeof window.desktopAPI })"))}`);
    await evaluate('document.querySelector(\'[data-tool="windowPin"]\').click()');
    const count = await evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const count = document.querySelectorAll('.window-pin-thumbnail img').length;
        if (count || Date.now() - started > 15000) { clearInterval(timer); resolve(count); }
      }, 100);
    })`);
    assert.ok(count > 0, `at least one window thumbnail is shown: ${await evaluate("document.querySelector('#windowList').textContent")}`);
    if (process.env.WINDOW_PIN_SCREENSHOT) {
      const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(`${process.env.WINDOW_PIN_SCREENSHOT}.list.png`, Buffer.from(shot.data, 'base64'));
    }
    const opened = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.window-pin-row')].filter((row) => row.querySelector('.window-pin-thumbnail img'));
      const target = rows.find((row) => /chrome|ChatGPT/i.test(row.querySelector('.window-pin-process').textContent))
        || rows.find((row) => !row.querySelector('.window-pin-title').textContent.startsWith('WindowPinTest-'));
      if (!target) return false;
      target.querySelector('.window-pin-thumbnail').click();
      const dialog = document.querySelector('#windowPreviewDialog');
      return dialog.open && document.querySelector('#windowPreviewImage').src.startsWith('data:image/png;base64,');
    })()`);
    assert.equal(opened, true);
    const previewWidth = await evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const width = document.querySelector('#windowPreviewImage').naturalWidth;
        if (width > 300 || Date.now() - started > 10000) { clearInterval(timer); resolve(width); }
      }, 100);
    })`);
    assert.ok(previewWidth > 300, `enlarged preview loaded at width ${previewWidth}`);
    if (process.env.WINDOW_PIN_SCREENSHOT) {
      const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(`${process.env.WINDOW_PIN_SCREENSHOT}.preview.png`, Buffer.from(shot.data, 'base64'));
    }
    const closed = await evaluate(`(() => {
      document.querySelector('#closeWindowPreview').click();
      return !document.querySelector('#windowPreviewDialog').open;
    })()`);
    assert.equal(closed, true);
  } finally {
    socket?.close();
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); }
    if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});
