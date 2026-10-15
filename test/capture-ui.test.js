const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
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

test('capture shows full screenshot and records colors by hover and click', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-ui-'));
  const port = await freePort();
  const executable = process.env.CAPTURE_APP || require('electron');
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
  if (!process.env.CAPTURE_APP) args.unshift(path.join(__dirname, '..'));
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
        if (window.desktopAPI && typeof desktopAPI.captureScreen === 'function' && document.querySelector('[data-tool="capture"]')) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > 10000) { clearInterval(timer); resolve(false); }
      }, 100);
    })`);
    assert.equal(ready, true, 'toolbox page is ready');
    await evaluate('document.querySelector(\'[data-tool="capture"]\').click()');
    await evaluate(`document.getElementById('captureScreenButton').click()`);
    await evaluate('new Promise((resolve) => { if (document.getElementById(\'captureCanvas\') && !document.getElementById(\'captureCanvas\').hidden) resolve(); else setTimeout(resolve, 50); })');
    const captured = await evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const canvas = document.getElementById('captureCanvas');
        if (canvas && !canvas.hidden && canvas.width > 0) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > 20000) { clearInterval(timer); resolve(false); }
      }, 100);
    })`);
    assert.ok(captured, 'screenshot renders into a full-size canvas');
    const canvasSize = await evaluate('(() => { const c = document.getElementById("captureCanvas"); return { w: c.width, h: c.height, natural: c.getBoundingClientRect().width > 0 }; })()');
    assert.ok(canvasSize.w > 0 && canvasSize.h > 0, `canvas has full image dimensions ${JSON.stringify(canvasSize)}`);
    const live = await evaluate(`(() => {
      const canvas = document.getElementById('captureCanvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true }));
      return document.getElementById('hexValue').textContent;
    })()`);
    assert.match(live, /^#[0-9A-F]{6}$/, `hover updates live color hex: ${live}`);
    const recorded = await evaluate(`new Promise((resolve) => {
      const canvas = document.getElementById('captureCanvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('click', { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true }));
      setTimeout(() => resolve(document.querySelectorAll('#recordedColors .recorded-color').length), 50);
    })`);
    assert.equal(recorded, 1, 'click records exactly one sampled color');
    const persisted = await evaluate('JSON.parse(localStorage.getItem("zhuomiantools.captureColors") || "[]").length');
    assert.equal(persisted, 1, 'recorded color is persisted to localStorage');
    const cleared = await evaluate(`new Promise((resolve) => {
      document.getElementById('clearColorsButton').click();
      setTimeout(() => resolve(document.querySelectorAll('#recordedColors .recorded-color').length), 50);
    })`);
    assert.equal(cleared, 0, 'clear button empties the recorded list');
  } finally {
    if (socket) socket.close();
    child.kill();
  }
});
