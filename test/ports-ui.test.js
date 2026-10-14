const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const path = require('node:path');

async function tcpServer() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}

async function openToolbox(t, { faultControl } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-ui-'));
  const userData = path.join(temp, 'data');
  const debugServer = await tcpServer();
  const debugPort = debugServer.address().port;
  await new Promise((resolve) => debugServer.close(resolve));
  const entry = path.join(__dirname, '..');
  const packaged = process.env.PORTS_APP && !faultControl;
  const executable = packaged ? process.env.PORTS_APP : require('electron');
  const args = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`];
  if (!packaged) args.unshift(entry);
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...(faultControl ? { PORTS_TEST_ERROR_FILE: faultControl } : {}) } });
  let socket;
  t.after(async () => {
    socket?.close();
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); }
    if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  let tab;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { tab = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((item) => item.type === 'page' && item.url.endsWith('/src/index.html')); } catch { /* starting */ }
    if (tab) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(tab, 'toolbox debugger page is available');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    function onMessage(event) {
      const reply = JSON.parse(event.data);
      if (reply.id !== id) return;
      clearTimeout(timer); socket.removeEventListener('message', onMessage);
      if (reply.error || reply.result?.exceptionDetails) reject(new Error(JSON.stringify(reply.error || reply.result.exceptionDetails)));
      else resolve(reply.result);
    }
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async (expression) => {
    const deadline = Date.now() + 15000;
    let lastError;
    while (Date.now() < deadline) {
      try { if (await evaluate(`Boolean(${expression})`)) return; }
      catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const state = await evaluate("({ url: location.href, ready: document.readyState, api: typeof window.desktopAPI, ports: !!document.querySelector('#portsView'), status: document.querySelector('#portStatus')?.textContent })").catch(() => null);
    assert.fail(`wait for ${expression}: ${JSON.stringify(state)} ${lastError || ''}`);
  };
  await waitFor("window.desktopAPI && typeof loadPorts === 'function'");
  return { call, evaluate, waitFor };
}

test('port tool queries real IPC, searches ports, sorts numerically and refreshes new endpoints', { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
  const server = await tcpServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const tcpPort = server.address().port;
  const { call, evaluate, waitFor } = await openToolbox(t);
  await evaluate(`document.querySelector('[data-tool="ports"]').click()`);
  assert.equal(await evaluate("!document.querySelector('#portsView').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#refreshPorts').disabled"), true);
  await waitFor("!document.querySelector('#refreshPorts').disabled");
  assert.equal(await evaluate("portsError"), '');
  const rows = await evaluate("portItems");
  const owner = rows.find((item) => item.protocol === 'TCP' && item.port === tcpPort && item.processId === process.pid);
  assert.ok(owner, 'real TCP listener and PID are loaded through IPC');
  assert.equal(owner.path.toLowerCase(), process.execPath.toLowerCase());
  assert.ok(await evaluate("[...document.querySelectorAll('#portList tr')].every(row => row.children.length === 7)"));
  if (process.env.PORTS_SCREENSHOT) {
    const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(process.env.PORTS_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await evaluate(`document.querySelector('#portSearch').value = '${tcpPort}'; document.querySelector('#portSearch').dispatchEvent(new Event('input'))`);
  assert.ok(await evaluate(`document.querySelectorAll('#portList .port-number').length > 0 && [...document.querySelectorAll('#portList .port-number')].every(cell => cell.textContent.includes('${tcpPort}'))`));
  await evaluate("document.querySelector('#portSearch').value = 'no-port'; document.querySelector('#portSearch').dispatchEvent(new Event('input'))");
  assert.match(await evaluate("document.querySelector('#portList').textContent"), /没有匹配/);

  // Stable data exposes lexicographic mistakes that a random machine's ports might miss.
  await evaluate(`portItems = [1000, 80, 443, 9].map(port => ({ protocol: 'TCP', address: '::1', port, processId: 42, processName: '<img src=x>', path: null })); document.querySelector('#portSearch').value = ''; document.querySelector('#portSearch').dispatchEvent(new Event('input'))`);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.port-number')].map(cell => Number(cell.textContent))"), [9, 80, 443, 1000]);
  assert.equal(await evaluate("document.querySelectorAll('#portList img').length"), 0);
  assert.match(await evaluate("document.querySelector('.port-path').textContent"), /无法读取/);
  await evaluate("document.querySelector('#portSort').value = 'desc'; document.querySelector('#portSort').dispatchEvent(new Event('change'))");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.port-number')].map(cell => Number(cell.textContent))"), [1000, 443, 80, 9]);
  await evaluate("document.querySelector('#portSearch').value = '0'; document.querySelector('#portSearch').dispatchEvent(new Event('input'))");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.port-number')].map(cell => Number(cell.textContent))"), [1000, 80]);

  const udp = dgram.createSocket('udp4');
  t.after(() => new Promise((resolve) => udp.close(resolve)));
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); });
  const udpPort = udp.address().port;
  await evaluate(`document.querySelector('#portSearch').value = '${udpPort}'; document.querySelector('#refreshPorts').click()`);
  await waitFor("!document.querySelector('#refreshPorts').disabled");
  assert.equal(await evaluate("document.querySelector('#portSort').value"), 'desc');
  assert.ok(await evaluate(`portItems.some(row => row.protocol === 'UDP' && row.port === ${udpPort} && row.processId === ${process.pid})`));
  assert.match(await evaluate("document.querySelector('#portList').textContent"), /已绑定/);
  assert.equal(await evaluate("document.querySelector('#portSearch').value"), String(udpPort));
});

test('port UI preserves loading and safe errors during filtering and recovers on retry', { skip: process.platform !== 'win32' || Boolean(process.env.PORTS_APP), timeout: 45000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-fault-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const control = path.join(temp, 'control.json');
  fs.writeFileSync(control, JSON.stringify({ error: '<img src=x onerror=alert(1)> 查询失败', delayMs: 500 }));
  const { evaluate, waitFor } = await openToolbox(t, { faultControl: control });
  await evaluate(`document.querySelector('[data-tool="ports"]').click(); document.querySelector('#portSearch').value = '80'; document.querySelector('#portSearch').dispatchEvent(new Event('input')); document.querySelector('#portSort').value = 'desc'; document.querySelector('#portSort').dispatchEvent(new Event('change')); loadPorts()`);
  assert.equal(await evaluate("document.querySelector('#portTableWrap').getAttribute('aria-busy')"), 'true');
  assert.match(await evaluate("document.querySelector('#portList').textContent"), /正在获取/);
  await waitFor("!document.querySelector('#refreshPorts').disabled");
  assert.match(await evaluate("document.querySelector('#portList').textContent"), /查询失败/);
  assert.equal(await evaluate("document.querySelectorAll('#portList img').length"), 0);
  await evaluate("document.querySelector('#portSearch').value = ''; document.querySelector('#portSearch').dispatchEvent(new Event('input'))");
  assert.match(await evaluate("document.querySelector('#portList').textContent"), /查询失败/);
  fs.writeFileSync(control, '{}');
  await evaluate("document.querySelector('#refreshPorts').click()");
  await waitFor("!document.querySelector('#refreshPorts').disabled");
  assert.equal(await evaluate("portsError"), '');
  assert.ok(await evaluate("document.querySelectorAll('#portList .port-number').length > 0"));
  assert.equal(await evaluate("document.querySelector('#portTableWrap').getAttribute('aria-busy')"), 'false');
});
