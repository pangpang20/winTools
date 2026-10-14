const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function openToolbox(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'responsive-ui-'));
  const userData = path.join(temp, 'data');
  fs.mkdirSync(userData);
  // Layout fixtures must never read the user's clipboard or register shortcuts.
  fs.writeFileSync(path.join(userData, 'toolbox-data.json'), JSON.stringify({ clipboardEnabled: false, shortcuts: Object.fromEntries(['showToolbox', 'startTimer', 'newNote', 'openClipboard', 'screenshot', 'colorPicker'].map(key => [key, ''])) }));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const executable = process.env.RESPONSIVE_APP || require('electron');
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
  if (!process.env.RESPONSIVE_APP) args.unshift(path.join(__dirname, '..'));
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
  let socket;
  t.after(async () => {
    socket?.close();
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); }
    if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  let tab;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.endsWith('/src/index.html')); } catch { /* starting */ }
    if (tab) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(tab, 'real Electron renderer is available');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
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
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`Boolean(${expression})`).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`wait for ${expression}`);
  };
  await waitFor("document.readyState === 'complete' && window.desktopAPI && typeof selectTool === 'function'");
  const resizeNative = (width, height) => {
    // Electron's page debugger does not implement Browser.setWindowBounds.
    // Resize only the window belonging to the process started by this test.
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ResponsiveWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int state);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  public static IntPtr Find(uint process) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(256); GetWindowText(h, title, 256);
      if (pid == process && title.ToString() == "桌面工具箱") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$handle = [ResponsiveWindow]::Find(${child.pid})
if ($handle -eq 0) { throw 'Test window not found' }
[void][ResponsiveWindow]::ShowWindow($handle, 4)
$scale = [ResponsiveWindow]::GetDpiForWindow($handle) / 96.0
if (-not [ResponsiveWindow]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, [int](${width} * $scale), [int](${height} * $scale), 0x16)) { throw 'Native resize failed' }
`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
  };
  return { call, evaluate, waitFor, resizeNative };
}

// Synthetic content exercises geometry without exposing live window titles,
// process arguments or clipboard contents. IPC behavior has separate UI tests.
function installFixtures() {
  const longText = '自适应布局测试内容'.repeat(45) + 'C:/verylongdirectory/'.repeat(30);
  const canvas = document.createElement('canvas');
  canvas.width = 960; canvas.height = 540;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#167f9a'; ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'; ctx.fillText('Layout preview', 50, 100);
  const image = canvas.toDataURL();
  notes = Array.from({ length: 10 }, (_, i) => ({ id: `layout-${i}`, text: longText, color: ['#f9d77e', '#9edcf4', '#b5e6c3'][i % 3] }));
  clipboardItems = Array.from({ length: 5 }, (_, i) => ({ id: `layout-${i}`, text: longText, pinned: i === 0 }));
  localStorage.setItem('zhuomiantools.reminders', JSON.stringify([{ id: 'layout-reminder', message: longText, at: Date.now() + 3600000 }]));
  renderReminders();
  state.fontSize = 144; state.elapsedMs = (99 * 3600 + 59 * 60 + 59) * 1000; renderTimer();
  document.querySelector('#speechFileName').textContent = longText + '.docx';
  document.querySelector('#speechText').value = longText.repeat(5);
  document.querySelector('#speechText').dispatchEvent(new Event('input'));
  document.querySelector('#capturePreview').innerHTML = `<img src="${image}" alt="合成截图">`;
  document.querySelector('#qrText').value = longText;
  document.querySelector('#qrOutput').innerHTML = `<img src="${image}" alt="合成二维码布局">`;
  loadPorts = async () => {
    portsLoading = false; portsError = '';
    portItems = Array.from({ length: 25 }, (_, i) => ({ protocol: 'TCP', address: '127.0.0.1', port: 8000 + i, processId: 42, processName: 'layout.exe', path: 'C:/layout/program.exe', commandLine: '"C:/layout/program.exe" --config=' + longText }));
    renderPorts();
  };
  renderExternalWindows = async () => {
    const list = document.querySelector('#windowList');
    list.innerHTML = `<div class="window-pin-row"><button class="window-pin-thumbnail" type="button" aria-label="放大合成缩略图"><img src="${image}" alt=""></button><div class="window-pin-details"><strong class="window-pin-title"></strong><span class="window-pin-process"></span></div><button class="primary-button" type="button">置顶</button></div>`;
    list.querySelector('.window-pin-title').textContent = longText;
    list.querySelector('.window-pin-process').textContent = longText;
    list.querySelector('.window-pin-thumbnail').onclick = () => {
      document.querySelector('#windowPreviewTitle').textContent = longText;
      document.querySelector('#windowPreviewImage').src = image;
      document.querySelector('#windowPreviewDialog').showModal();
    };
  };
}

function measureLayout() {
  const main = document.querySelector('.main-content');
  const bounds = main.getBoundingClientRect();
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).opacity !== '0';
  const outside = [...main.querySelectorAll('*')].filter(visible).filter(element => {
    if (element.closest('.port-table')) return false; // The table intentionally scrolls within its own container.
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
  }).map(element => `${element.tagName}#${element.id}.${element.className}`);
  const unreachable = [];
  for (const element of [...main.querySelectorAll('button, input, select')].filter(visible)) {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1 || !(hit === element || element.contains(hit))) unreachable.push(element.id || element.className);
  }
  main.scrollTop = 0;
  const active = document.querySelector(`.generic-view:not([hidden]), .timer-layout:not([hidden])`);
  const style = getComputedStyle(main);
  const grid = active.querySelector('.view-grid, .capture-grid, .qr-layout, .tts-layout') || (active.classList.contains('timer-layout') ? active : null);
  let columns;
  if (grid) {
    const [a, b] = [...grid.children].map(element => element.getBoundingClientRect());
    columns = Math.abs(a.top - b.top) < 1 ? 2 : 1;
  }
  const timer = document.querySelector('#timerDisplay');
  const range = document.createRange(); range.selectNodeContents(timer);
  return {
    outside, unreachable, documentOverflow: document.documentElement.scrollWidth > innerWidth,
    mainOverflow: main.scrollWidth > main.clientWidth + 1,
    viewWidth: active.getBoundingClientRect().width,
    available: main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    columns, computedColumns: grid && getComputedStyle(grid).gridTemplateColumns, containerWidth: getComputedStyle(main).width,
    noteColumns: getComputedStyle(document.querySelector('#notesGrid')).gridTemplateColumns.split(' ').length,
    timerClipped: currentTool === 'timer' && range.getBoundingClientRect().width > document.querySelector('.timer-display-wrap').clientWidth + 1,
    editorHeight: document.querySelector('.speech-text').clientHeight,
    sidebarScrollable: document.querySelector('.sidebar').scrollHeight > document.querySelector('.sidebar').clientHeight
  };
}

test('all twelve tool panels adapt to native resizing, narrow and wide viewports in five themes', { skip: process.platform !== 'win32', timeout: 300000 }, async t => {
  const { call, evaluate, waitFor, resizeNative } = await openToolbox(t);
  await evaluate(`(${installFixtures.toString()})()`);
  const tools = await evaluate("[...document.querySelectorAll('[data-tool]')].map(button => button.dataset.tool)");
  assert.equal(tools.length, 12);
  await t.test('the native window can resize to 640 by 480 and keeps all navigation reachable', async () => {
    resizeNative(640, 480);
    await waitFor('innerWidth === 640 && innerHeight === 480');
    assert.equal(await evaluate("document.querySelector('.sidebar').scrollHeight > document.querySelector('.sidebar').clientHeight"), true);
    await evaluate("document.querySelector('[data-tool=settings]').scrollIntoView({block:'nearest'})");
    assert.equal(await evaluate("(() => { const button = document.querySelector('[data-tool=settings]'); const r = button.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width/2, r.top + r.height/2)?.closest('button') === button; })()"), true);
    resizeNative(1200, 820);
    await waitFor('innerWidth === 1200 && innerHeight === 820');
  });
  const results = {};
  const screenshot = async name => {
    if (!process.env.RESPONSIVE_SCREENSHOTS) return;
    fs.mkdirSync(process.env.RESPONSIVE_SCREENSHOTS, { recursive: true });
    const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(process.env.RESPONSIVE_SCREENSHOTS, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  for (const theme of ['dark', 'light', 'forest', 'coral', 'graphite']) {
    for (const [width, height] of [[640, 480], [980, 640], [1200, 820], [1920, 1080]]) {
      await t.test(`${theme} ${width} x ${height}: twelve panels and every action fit`, async () => {
        await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await evaluate(`document.querySelector('#themeToggle').click(); document.querySelector('[data-theme-option="${theme}"]').click()`);
        for (const tool of tools) {
          await evaluate(`document.querySelector('[data-tool="${tool}"]').click()`);
          if (tool === 'settings') await waitFor('document.querySelectorAll(".shortcut-input").length === 6');
          if (tool === 'converter') await evaluate("document.querySelector('#converterOutput').textContent = '1234567890'.repeat(15)");
          await evaluate('new Promise(resolve => setTimeout(resolve, 250))');
          const metrics = await evaluate(`(${measureLayout.toString()})()`);
          results[`${theme}-${width}-${height}-${tool}`] = metrics;
          const heading = await evaluate(`(() => {
            const visible = element => element.getClientRects().length > 0;
            const title = document.querySelector('#pageTitle');
            const controls = document.querySelector('#timerHeadingActions');
            const eyebrow = document.querySelector('#timerEyebrow');
            const view = document.querySelector('.generic-view:not([hidden])');
            const toolbar = view?.querySelector('.section-toolbar');
            const actions = toolbar && [...toolbar.children].filter(visible);
            return {
              title: title.textContent,
              timerControlsVisible: visible(controls),
              timerEyebrowVisible: visible(eyebrow),
              duplicateTitles: view ? [...view.querySelectorAll('.section-toolbar h2, .focus-card h2')].filter(visible).map(element => element.textContent) : [],
              actionCount: actions?.length || 0,
              actionRight: actions?.length ? actions[0].getBoundingClientRect().right > toolbar.getBoundingClientRect().right - 2 : true
            };
          })()`);
          assert.equal(heading.timerControlsVisible, tool === 'timer', `${tool}: timer controls belong only to timer`);
          assert.equal(heading.timerEyebrowVisible, tool === 'timer', `${tool}: timer label belongs only to timer`);
          assert.deepEqual(heading.duplicateTitles, [], `${tool}: page title appears only once`);
          if (tool !== 'timer' && tool !== 'pomodoro' && !['reminders', 'qr', 'settings'].includes(tool)) {
            assert.equal(heading.actionCount, 1, `${tool}: its own toolbar remains available`);
            assert.equal(heading.actionRight, true, `${tool}: its own action stays right aligned`);
          }
          assert.deepEqual(metrics.outside, [], `${tool}: elements stay inside the right panel`);
          assert.deepEqual(metrics.unreachable, [], `${tool}: controls remain reachable through scrolling`);
          assert.equal(metrics.documentOverflow || metrics.mainOverflow, false, `${tool}: no page horizontal overflow`);
          assert.ok(Math.abs(metrics.viewWidth - metrics.available) < 2, `${tool}: uses all available width`);
          if (metrics.columns) assert.equal(metrics.columns, metrics.available <= 740 ? 1 : 2, `${tool}: columns adapt to available space ${JSON.stringify(metrics)}`);
          assert.equal(metrics.timerClipped, false, '144px timer remains readable');
          if ((width === 640 && ['timer', 'notes', 'tts', 'windowPin'].includes(tool)) || (width === 1920 && ['notes', 'tts', 'ports'].includes(tool))) await screenshot(`${theme}-${width}-${tool}`);
        }
      });
    }
  }
  await t.test('content grows with width and height; local table scrolling keeps headers and actions visible', async () => {
    assert.equal(results['dark-640-480-notes'].noteColumns, 1);
    assert.ok(results['dark-1920-1080-notes'].noteColumns >= 5);
    assert.ok(results['dark-1920-1080-tts'].editorHeight > results['dark-1200-820-tts'].editorHeight + 100);
    await call('Emulation.setDeviceMetricsOverride', { width: 640, height: 480, deviceScaleFactor: 1, mobile: false });
    await evaluate("selectTool('ports'); document.querySelector('#portSearch').value = '800'; document.querySelector('#portSearch').dispatchEvent(new Event('input')); document.querySelector('#portSort').value = 'desc'; document.querySelector('#portSort').dispatchEvent(new Event('change'))");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.port-number')].map(cell => Number(cell.textContent))"), Array.from({ length: 10 }, (_, i) => 8009 - i));
    const table = await evaluate("(() => { const wrap = document.querySelector('#portTableWrap'); wrap.scrollIntoView({block:'start'}); wrap.scrollLeft = 2000; wrap.scrollTop = 300; const head = wrap.querySelector('th').getBoundingClientRect(); const r = wrap.getBoundingClientRect(); return { x: wrap.scrollLeft, y: wrap.scrollTop, sticky: Math.abs(head.top - r.top) < 3, mainOverflow: document.querySelector('.main-content').scrollWidth > document.querySelector('.main-content').clientWidth }; })()");
    assert.ok(table.x > 0 && table.y > 0, 'only the table scrolls in both directions');
    assert.equal(table.sticky, true, 'column headings stay visible');
    assert.equal(table.mainOverflow, false);
    await evaluate("selectTool('windowPin'); document.querySelector('.window-pin-thumbnail').scrollIntoView({block:'nearest'}); document.querySelector('.window-pin-thumbnail').click()");
    assert.equal(await evaluate("(() => { const r = document.querySelector('#windowPreviewDialog').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), true);
    await screenshot('light-640-enlarged-preview');
    await evaluate("document.querySelector('#closeWindowPreview').click()");
    assert.equal(await evaluate("document.querySelector('#windowPreviewDialog').open"), false);
  });
});
