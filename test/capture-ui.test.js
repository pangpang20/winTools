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

test('capture magnifies exact native pixels, supports precision keys and preserves color history', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
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
    const evaluate = async (expression) => {
      try { return (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value; }
      catch (error) { throw new Error(`${expression.slice(0, 160)}: ${error.message}`); }
    };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = await evaluate("document.readyState === 'complete' && window.desktopAPI && typeof CapturePicker !== 'undefined' && typeof selectTool === 'function'").catch(() => false);
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
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
    assert.ok(captured, `screenshot renders into a full-size canvas: ${await evaluate("JSON.stringify({status: document.getElementById('captureStatus').textContent, toast: document.querySelector('.flash-message')?.textContent})")}`);
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

    // A known full-resolution image makes off-by-one and interpolation errors observable.
    await evaluate(`(() => {
      const c = document.getElementById('captureCanvas'); c.width = 1600; c.height = 900;
      const ctx = c.getContext('2d'); const image = ctx.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        image.data[i] = x % 256; image.data[i + 1] = y % 256; image.data[i + 2] = 51; image.data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      window.hoverPixel = (x, y, type = 'mousemove') => {
        const b = CapturePicker.imageBounds(c.getBoundingClientRect(), c.width, c.height);
        c.dispatchEvent(new PointerEvent(type, { clientX: b.left + (x + .5) * b.scale, clientY: b.top + (y + .5) * b.scale, bubbles: true }));
      };
    })()`);
    const readLoupe = () => evaluate(`(() => {
      const l = document.getElementById('captureLoupe'); const c = document.getElementById('captureLoupeCanvas'); const r = l.getBoundingClientRect();
      return { hidden: l.hidden, hex: document.getElementById('captureLoupeHex').textContent, live: document.getElementById('hexValue').textContent,
        rgb: document.getElementById('captureLoupeRgb').textContent, position: document.getElementById('captureLoupePosition').textContent,
        size: c.width, pixel: [...c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data],
        inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        ignoresPointer: getComputedStyle(l).pointerEvents === 'none' };
    })()`);
    await evaluate('hoverPixel(527, 301)');
    let loupe = await readLoupe();
    assert.equal(loupe.hidden, false);
    assert.equal(loupe.hex, '#0F2D33');
    assert.equal(loupe.live, loupe.hex);
    assert.equal(loupe.rgb, 'RGB 15, 45, 51');
    assert.equal(loupe.position, 'X 527 · Y 301 · 12×');
    assert.deepEqual(loupe.pixel, [15, 45, 51, 255], 'loupe center is the original pixel without interpolation');
    assert.ok(loupe.inViewport && loupe.ignoresPointer);
    assert.equal(await evaluate("document.querySelectorAll('#recordedColors .recorded-color').length"), 0, 'hover does not record');

    for (const zoom of [8, 16, 12]) {
      await evaluate(`document.getElementById('captureZoom').value = '${zoom}'; document.getElementById('captureZoom').dispatchEvent(new Event('change')); hoverPixel(527, 301)`);
      loupe = await readLoupe(); assert.equal(loupe.size, 15 * zoom); assert.equal(loupe.hex, '#0F2D33');
      assert.deepEqual(loupe.pixel, [15, 45, 51, 255]);
    }
    await evaluate(`(() => {
      const c = document.getElementById('captureCanvas'); const b = c.getBoundingClientRect();
      c.dispatchEvent(new WheelEvent('wheel', { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, deltaY: -100, cancelable: true }));
    })()`);
    assert.equal(await evaluate("document.getElementById('captureZoom').value"), '16', 'scroll up increases pixel magnification');

    await evaluate("hoverPixel(527, 301); document.getElementById('captureCanvas').focus()");
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
    loupe = await readLoupe(); assert.equal(loupe.hex, '#102D33'); assert.match(loupe.position, /X 528 · Y 301/);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("zhuomiantools.captureColors"))'), ['#102D33', '#0F2D33']);
    await evaluate("document.querySelector('#recordedColors .recorded-copy').click()");
    await evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    assert.equal(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true }).trim(), '#102D33', 'recorded HEX copies through real clipboard IPC');

    for (const [x, y] of [[0, 0], [1599, 0], [0, 899], [1599, 899]]) {
      await evaluate(`hoverPixel(${x}, ${y})`);
      loupe = await readLoupe();
      assert.ok(loupe.inViewport, `edge loupe stays visible at ${x},${y}`);
      assert.deepEqual(loupe.pixel, [x % 256, y % 256, 51, 255], 'edge padding does not shift the central pixel');
    }
    await evaluate("hoverPixel(0, 0); document.getElementById('captureCanvas').focus()");
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' });
    assert.match((await readLoupe()).position, /X 0 · Y 0/);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    assert.equal((await readLoupe()).hidden, true, 'Escape exits precision picking');
    assert.equal(await evaluate("document.activeElement.id === 'captureCanvas'"), false);

    await evaluate("hoverPixel(527, 301); document.getElementById('captureCanvas').dispatchEvent(new MouseEvent('mouseleave'))");
    assert.equal((await readLoupe()).hidden, true, 'leaving screenshot dismisses the loupe');
    await evaluate("hoverPixel(527, 301); document.querySelector('[data-tool=timer]').click()");
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    assert.equal((await readLoupe()).hidden, true, 'switching tools dismisses floating overlays');
    await evaluate("document.querySelector('[data-tool=capture]').click()");

    for (const theme of ['dark', 'light']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'; document.documentElement.dataset.tone = '${theme}'; hoverPixel(800, 450)`);
      assert.ok((await readLoupe()).inViewport);
      if (process.env.CAPTURE_SCREENSHOT) {
        fs.mkdirSync(path.dirname(process.env.CAPTURE_SCREENSHOT), { recursive: true });
        const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.writeFileSync(`${process.env.CAPTURE_SCREENSHOT}.${theme}.png`, Buffer.from(shot.data, 'base64'));
      }
    }
    await call('Emulation.setDeviceMetricsOverride', { width: 640, height: 480, deviceScaleFactor: 1.5, mobile: false });
    await evaluate("document.getElementById('captureCanvas').scrollIntoView({block: 'center'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await evaluate('hoverPixel(1599, 899)');
    loupe = await readLoupe(); assert.ok(loupe.inViewport, 'loupe fits narrow high-DPI viewport');
    assert.deepEqual(loupe.pixel, [63, 131, 51, 255]);
    if (process.env.CAPTURE_SCREENSHOT) {
      const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(`${process.env.CAPTURE_SCREENSHOT}.narrow.png`, Buffer.from(shot.data, 'base64'));
      assert.equal((await readLoupe()).hidden, false, 'loupe remains visible after the viewport settles');
    }
    await evaluate("document.querySelector('.main-content').dispatchEvent(new Event('scroll'))");
    assert.equal((await readLoupe()).hidden, true, 'scroll dismisses obsolete floating position');
  } finally {
    if (socket) socket.close();
    child.kill();
  }
});
