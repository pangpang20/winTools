const assert = require('node:assert/strict');
const { test } = require('node:test');
const net = require('node:net');
const dgram = require('node:dgram');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { queryScript, parsePortOutput, createPortService } = require('../src/ports');

const sample = { Protocol: 'TCP', Address: '127.0.0.1', Port: 8080, ProcessId: 42, ProcessName: '测试进程', Path: 'C:\\测试目录\\程序.exe', CommandLine: '"C:\\测试目录\\程序.exe" --name "中文 参数"  --port=8080' };

test('parses arrays and single rows, preserving Unicode paths and full command lines', () => {
  const expected = { protocol: 'TCP', address: '127.0.0.1', port: 8080, processId: 42, processName: '测试进程', path: sample.Path, commandLine: sample.CommandLine };
  assert.deepEqual(parsePortOutput(JSON.stringify(sample)), [expected]);
  assert.deepEqual(parsePortOutput(JSON.stringify([sample, { ...sample, Protocol: 'udp', Address: '::', Path: null }])), [expected, { ...expected, protocol: 'UDP', address: '::', path: null }]);
  assert.deepEqual(parsePortOutput('[]'), []);
  assert.deepEqual(parsePortOutput(''), []);
});

test('keeps endpoints whose process path, PID or command line cannot be read', () => {
  const [row] = parsePortOutput(JSON.stringify({ ...sample, Path: '', ProcessId: null, ProcessName: '' }));
  assert.equal(row.port, 8080);
  assert.equal(row.path, null);
  assert.equal(row.processId, null);
  assert.equal(row.processName, '未知进程');
  for (const CommandLine of [null, undefined, '', '  ']) {
    const [endpoint] = parsePortOutput(JSON.stringify({ ...sample, CommandLine }));
    assert.equal(endpoint.port, sample.Port);
    assert.equal(endpoint.path, sample.Path);
    assert.equal(endpoint.commandLine, null);
  }
});

test('rejects malformed JSON and excludes invalid endpoints', () => {
  assert.throws(() => parsePortOutput('not JSON'), /无效数据/);
  assert.deepEqual(parsePortOutput(JSON.stringify([null, {}, { ...sample, Port: -1 }, { ...sample, Port: 65536 }, { ...sample, Port: 12.5 }, { ...sample, Port: '80' }, { ...sample, Protocol: 'ICMP' }])), []);
});

test('shares simultaneous scans and performs a fresh scan on refresh', async () => {
  let calls = 0;
  let release;
  const service = createPortService({ platform: 'win32', execute: () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  const first = service.list();
  const second = service.list();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release(JSON.stringify(sample));
  assert.deepEqual(await first, await second);
  const refresh = service.list();
  await Promise.resolve();
  assert.equal(calls, 2);
  release('[]');
  assert.deepEqual(await refresh, []);
});

test('clears failed scans so command or parse errors can be retried', async () => {
  const outputs = [new Error('查询被拒绝'), 'invalid JSON', JSON.stringify(sample)];
  const service = createPortService({ platform: 'win32', execute: async () => { const output = outputs.shift(); if (output instanceof Error) throw output; return output; } });
  await assert.rejects(service.list(), /查询被拒绝/);
  await assert.rejects(service.list(), /无效数据/);
  assert.equal((await service.list())[0].port, 8080);
});

test('reports the Windows-only boundary before running a command', async () => {
  const service = createPortService({ platform: 'linux', execute: () => { throw new Error('must not run'); } });
  await assert.rejects(service.list(), /仅支持 Windows/);
});

function executePowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
}

test('real PowerShell permits empty results and propagates missing commands', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const emptyQueries = queryScript.replace('Get-NetTCPConnection -State Listen', 'Get-NetTCPConnection -State Listen -LocalPort 0').replace('Get-NetUDPEndpoint -ErrorAction', 'Get-NetUDPEndpoint -LocalPort 0 -ErrorAction');
  assert.deepEqual(parsePortOutput(await executePowerShell(emptyQueries)), []);
  await assert.rejects(executePowerShell(queryScript.replace('Get-NetTCPConnection -State Listen', 'MissingPortQueryCommand')));
});

test('real Windows scan resolves TCP/UDP IPv4/IPv6 ports to PID, path and command line', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const endpoints = [];
  for (const address of ['127.0.0.1', '::1']) {
    const tcp = net.createServer();
    t.after(() => new Promise((resolve) => tcp.close(resolve)));
    await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, address, resolve); });
    endpoints.push({ protocol: 'TCP', address, port: tcp.address().port });
    const udp = dgram.createSocket(address === '::1' ? 'udp6' : 'udp4');
    t.after(() => new Promise((resolve) => udp.close(resolve)));
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, address, resolve); });
    endpoints.push({ protocol: 'UDP', address, port: udp.address().port });
  }
  const rows = await createPortService().list();
  for (const endpoint of endpoints) {
    const row = rows.find((item) => item.protocol === endpoint.protocol && item.address === endpoint.address && item.port === endpoint.port && item.processId === process.pid);
    assert.ok(row, `endpoint is listed: ${JSON.stringify(endpoint)}`);
    assert.equal(path.normalize(row.path).toLowerCase(), path.normalize(process.execPath).toLowerCase());
    assert.ok(row.processName);
    assert.ok(row.commandLine.toLowerCase().includes(process.execPath.toLowerCase()));
    assert.ok(row.commandLine.includes(path.basename(__filename)));
  }
});

test('real Windows scan preserves child process startup arguments', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const code = 'require("node:net").createServer().listen(0,"127.0.0.1",function(){console.log(this.address().port)})';
  const child = spawn(process.execPath, ['-e', code, '--', '--label=中文 空格 "引号"', '--literal=<img src=x>'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child listener did not start')), 5000);
    let output = '';
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`child exited: ${code}`)); });
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); resolve(Number(output.trim())); } });
  });
  const rows = await createPortService().list();
  const row = rows.find((item) => item.protocol === 'TCP' && item.port === port && item.processId === child.pid);
  assert.ok(row, 'child TCP listener is present');
  assert.equal(row.path.toLowerCase(), process.execPath.toLowerCase());
  assert.ok(row.commandLine.includes('--label=中文 空格'));
  assert.ok(row.commandLine.includes('引号'));
  assert.ok(row.commandLine.includes('--literal=<img src=x>'));
});

test('unavailable CIM command lines keep readable endpoint and process information', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const tcp = net.createServer();
  t.after(() => new Promise((resolve) => tcp.close(resolve)));
  await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve); });
  let calls = 0;
  const script = `function Get-CimInstance { $script:commandLineQueries++; throw 'CIM query denied' }\n$script:commandLineQueries = 0\n${queryScript}\nif ($script:commandLineQueries -ne 1) { throw 'command lines must be queried once per scan' }`;
  const rows = await createPortService({ execute: async () => { calls++; return executePowerShell(script); } }).list();
  const row = rows.find((item) => item.protocol === 'TCP' && item.port === tcp.address().port && item.processId === process.pid);
  assert.equal(calls, 1);
  assert.ok(row, 'CIM failure does not discard the endpoint');
  assert.equal(row.path.toLowerCase(), process.execPath.toLowerCase());
  assert.equal(row.commandLine, null);
});
