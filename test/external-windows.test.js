const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { createExternalWindowService } = require('../src/external-windows');

const sample = { Handle: '1234567890123456', Title: '<test window>', ProcessId: 42, ProcessName: 'sample', Topmost: false };

test('lists a single window and tracks pinning through shutdown', async () => {
  const calls = [];
  const service = createExternalWindowService({
    execute: async (script) => { calls.push(script); return script.includes('::List(') ? JSON.stringify(sample) : 'True'; },
    executeSync: (script) => calls.push(script),
    selfPid: 99
  });
  assert.deepEqual(await service.list(), [{ handle: sample.Handle, title: sample.Title, processId: 42, processName: 'sample', topmost: false, managed: false }]);
  assert.deepEqual(await service.toggle(sample.Handle, true), { handle: sample.Handle, enabled: true });
  assert.equal((await service.list())[0].managed, true);
  service.release();
  assert.match(calls.at(-1), /SetTopmost\(\[Int64\]1234567890123456, \$false\)/);
});

test('rejects invalid and stale handles', async () => {
  const service = createExternalWindowService({ execute: async () => '[]' });
  await assert.rejects(service.toggle('1; exit', true), /无效/);
  await assert.rejects(service.toggle('9223372036854775808', true), /无效/);
  await assert.rejects(service.toggle('123', true), /已关闭/);
});

test('pins and unpins a real Windows test window', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const title = `WindowPinTest-${process.pid}`;
  const script = `Add-Type -AssemblyName System.Windows.Forms; $form = New-Object System.Windows.Forms.Form; $form.Text = '${title}'; $form.Show(); Write-Output $form.Handle.ToInt64(); [System.Windows.Forms.Application]::Run($form)`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('测试窗口启动超时')), 10000);
      child.once('error', reject);
      child.stdout.on('data', (data) => { output += data.toString(); if (/\d+/.test(output)) { clearTimeout(timer); resolve(); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`测试窗口提前退出: ${code}`)); });
    });
    const service = createExternalWindowService();
    const window = (await service.list()).find((item) => item.title === title);
    assert.ok(window, 'test window is enumerated');
    await service.toggle(window.handle, false);
    assert.equal((await service.list()).find((item) => item.handle === window.handle).topmost, false);
    await service.toggle(window.handle, true);
    const pinnedWindow = (await service.list()).find((item) => item.handle === window.handle);
    assert.equal(pinnedWindow.topmost, true, JSON.stringify(pinnedWindow));
    await service.toggle(window.handle, false);
    assert.equal((await service.list()).find((item) => item.handle === window.handle).topmost, false);
    service.release();
  } finally { child.kill(); }
});
