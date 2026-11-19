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

test('memory cleaner scans, groups and protects system processes', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ui-'));
  const port = await freePort();
  const executable = process.env.MEMORY_APP || require('electron');
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
  if (!process.env.MEMORY_APP) args.unshift(path.join(__dirname, '..'));
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
        if (window.desktopAPI && typeof renderMemory === 'function' && document.querySelector('[data-tool="memory"]')) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > 10000) { clearInterval(timer); resolve(false); }
      }, 100);
    })`);
    assert.equal(ready, true, `toolbox page is ready: ${JSON.stringify(await evaluate("({ url: location.href, state: document.readyState, title: document.title, nav: !!document.querySelector('[data-tool=memory]'), api: typeof window.desktopAPI })"))}`);
    await evaluate('document.querySelector(\'[data-tool="memory"]\').click()');
    const status = await evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const text = document.querySelector('#memoryStatus').textContent;
        if (text.includes('组进程') || text.includes('失败')) { clearInterval(timer); resolve(text); }
        else if (Date.now() - started > 15000) { clearInterval(timer); resolve('timeout'); }
      }, 100);
    })`);
    assert.match(status, /组进程/);
    const rows = await evaluate(`[...document.querySelectorAll('#memoryList tr')].map((row) => row.textContent)`);
    assert.ok(rows.some((text) => text.includes('可安全停止')));
    assert.ok(rows.some((text) => text.includes('建议人工确认')));
    assert.ok(rows.some((text) => text.includes('系统关键进程')));
    const protectedNoButton = await evaluate(`[...document.querySelectorAll('#memoryList tr')].filter((row) => row.textContent.includes('系统关键进程')).every((row) => !row.querySelector('button'))`);
    assert.equal(protectedNoButton, true);
  } finally {
    if (socket) socket.close();
    child.kill();
  }
});
