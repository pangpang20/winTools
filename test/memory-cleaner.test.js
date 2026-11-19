const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseProcessOutput, classifyProcess, buildScanResult, createMemoryCleanerService } = require('../src/memory-cleaner');

const sample = { ProcessId: 42, Name: '测试进程.exe', WorkingSetSize: 1024 * 1024 };

test('parses single rows, arrays and drops invalid entries', () => {
  const expected = { processId: 42, processName: '测试进程.exe', memoryBytes: 1048576, user: null, description: null };
  assert.deepEqual(parseProcessOutput(JSON.stringify(sample)), [{ ...expected, hasWindow: false }]);
  assert.deepEqual(parseProcessOutput(JSON.stringify([{ ...sample, User: 'pangpang', Description: '钉钉文档' }])), [{ ...expected, hasWindow: false, user: 'pangpang', description: '钉钉文档' }]);
  assert.deepEqual(parseProcessOutput(''), []);
  assert.throws(() => parseProcessOutput('not JSON'), /无效数据/);
});

test('classifies system, app and safe processes with reasons', () => {
  assert.deepEqual(classifyProcess({ processName: 'svchost.exe', processId: 1, memoryBytes: 1 }), { level: 'protected', label: '系统关键进程', reason: 'Windows 核心组件，结束可能导致系统不稳定' });
  assert.deepEqual(classifyProcess({ processName: 'explorer.exe', processId: 2, memoryBytes: 1 }), { level: 'protected', label: '桌面进程', reason: 'Explorer 提供桌面和任务栏，结束会黑屏' });
  assert.deepEqual(classifyProcess({ processName: 'zhuomiantools.exe', processId: 3, memoryBytes: 1 }), { level: 'protected', label: '当前应用', reason: '桌面工具箱自身进程，不能自行结束' });
  assert.deepEqual(classifyProcess({ processName: 'WeChatAppEx.exe', processId: 4, memoryBytes: 1, hasWindow: true }), { level: 'safe', label: '可安全停止', reason: '聊天、办公或浏览器进程，空闲时内存占用较高' });
  assert.deepEqual(classifyProcess({ processName: 'Steam.exe', processId: 5, memoryBytes: 1, hasWindow: true }), { level: 'safe', label: '可安全停止', reason: '下载、网盘或客户端常驻进程，通常可暂停' });
  assert.deepEqual(classifyProcess({ processName: 'DingTalkDoc.exe', processId: 7, memoryBytes: 1, hasWindow: false }), { level: 'safe', label: '后台驻留', reason: '当前没有打开的窗口，通常是关闭应用后残留的后台进程' });
  assert.deepEqual(classifyProcess({ processName: 'DingTalkDoc.exe', processId: 7, memoryBytes: 1, hasWindow: false }), { level: 'safe', label: '后台驻留', reason: '当前没有打开的窗口，通常是关闭应用后残留的后台进程' });
});

test('groups duplicate names, sorts by risk then memory and summarizes', () => {
  const rows = [
    { processId: 1, processName: 'WeChatAppEx.exe', memoryBytes: 200, hasWindow: true, user: 'pangpang', description: '微信' },
    { processId: 2, processName: 'WeChatAppEx.exe', memoryBytes: 100, hasWindow: false, user: 'pangpang', description: '微信' },
    { processId: 3, processName: 'svchost.exe', memoryBytes: 3000, hasWindow: true, user: 'SYSTEM', description: 'Windows 服务' },
    { processId: 4, processName: 'custom-tool.exe', memoryBytes: 1500, hasWindow: true, user: null, description: null }
  ];
  const { results, summary } = buildScanResult(rows);
  assert.equal(results.length, 3);
  assert.equal(results[0].processName, 'WeChatAppEx.exe');
  assert.equal(results[0].memoryBytes, 300);
  assert.deepEqual(results[0].instances, [{ processId: 1, hasWindow: true }, { processId: 2, hasWindow: false }]);
  assert.deepEqual(results[0].users, ['pangpang']);
  assert.deepEqual(results[0].descriptions, ['微信']);
  assert.equal(results[1].processName, 'custom-tool.exe');
  assert.equal(results[2].processName, 'svchost.exe');
  assert.deepEqual(summary, { safeCount: 1, safeBytes: 300, total: 3 });
});

test('mixed instances keep the safe-with-window label for grouped rows', () => {
  const rows = [
    { processId: 1, processName: 'chrome.exe', memoryBytes: 100, hasWindow: false, user: 'p', description: 'Chrome' },
    { processId: 2, processName: 'chrome.exe', memoryBytes: 200, hasWindow: true, user: 'p', description: 'Chrome' }
  ];
  const [group] = buildScanResult(rows).results;
  assert.equal(group.label, '可安全停止');
  assert.equal(group.reason, '聊天、办公或浏览器进程，空闲时内存占用较高');
});

test('service caches concurrent scans and kills only valid ids', async () => {
  let calls = 0;
  const output = JSON.stringify([{ ...sample, ProcessId: 7, WorkingSetSize: 512 }]);
  const service = createMemoryCleanerService({ platform: 'win32', executeScan: () => { calls++; return Promise.resolve(output); }, executeKill: (pid) => Promise.resolve(`成功: 已终止 PID ${pid}`), selfPid: 999 });
  const first = service.scan();
  const second = service.scan();
  assert.equal(first, second);
  await first;
  const refresh = service.scan();
  await refresh;
  assert.equal(calls, 2);
  await assert.rejects(service.kill(0), /无效的进程 ID/);
  await assert.rejects(service.kill(999), /不能结束桌面工具箱自身进程/);
  await assert.doesNotReject(service.kill(7));
});
