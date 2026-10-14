const { execFile } = require('node:child_process');

const queryScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$processCache = @{}
$commandLines = @{}
try {
  Get-CimInstance -ClassName Win32_Process -Property ProcessId,CommandLine -ErrorAction Stop |
    ForEach-Object { $commandLines[[int]$_.ProcessId] = $_.CommandLine }
} catch { }
function Convert-PortRow($endpoint, $protocol) {
  $ownerId = [int]$endpoint.OwningProcess
  if (!$processCache.ContainsKey($ownerId)) {
    $owner = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
    $programPath = $null
    if ($owner) { try { $programPath = $owner.Path } catch { } }
    $processCache[$ownerId] = [pscustomobject]@{
      Name = if ($owner) { [string]$owner.ProcessName } else { '未知进程（可能已退出）' }
      Path = if ($programPath) { [string]$programPath } else { $null }
    }
  }
  $info = $processCache[$ownerId]
  [pscustomobject]@{
    Protocol = $protocol; Address = [string]$endpoint.LocalAddress; Port = [int]$endpoint.LocalPort
    ProcessId = $ownerId; ProcessName = $info.Name; Path = $info.Path; CommandLine = $commandLines[$ownerId]
  }
}
$rows = @()
try { $rows += Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { Convert-PortRow $_ 'TCP' } }
catch { if ($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*') { throw } }
try { $rows += Get-NetUDPEndpoint -ErrorAction Stop | ForEach-Object { Convert-PortRow $_ 'UDP' } }
catch { if ($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*') { throw } }
ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
`;

function encodedArgs(script) { return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]; }

function runQuery(script = queryScript) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', encodedArgs(script), { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(error.killed ? '端口查询超时，请刷新重试' : `端口查询失败：${stderr.trim() || error.message}`)); return; }
      resolve(stdout.trim());
    });
  });
}

function normalizePort(item) {
  if (!item || typeof item.Port !== 'number' || !Number.isInteger(item.Port) || item.Port < 0 || item.Port > 65535) return null;
  const protocol = String(item.Protocol || '').toUpperCase();
  if (protocol !== 'TCP' && protocol !== 'UDP') return null;
  const processId = Number.isInteger(item.ProcessId) && item.ProcessId >= 0 ? item.ProcessId : null;
  return { protocol, address: String(item.Address || '*'), port: item.Port, processId, processName: String(item.ProcessName || '未知进程'), path: item.Path ? String(item.Path) : null, commandLine: typeof item.CommandLine === 'string' && item.CommandLine.trim() ? item.CommandLine : null };
}

function parsePortOutput(output) {
  if (!output || !String(output).trim()) return [];
  let parsed;
  try { parsed = JSON.parse(output); } catch (error) { throw new Error(`端口查询返回无效数据: ${error.message}`); }
  return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizePort).filter(Boolean);
}

function createPortService({ execute = runQuery, platform = process.platform } = {}) {
  let pending;
  return {
    list() {
      if (platform !== 'win32') return Promise.reject(new Error('端口进程工具仅支持 Windows'));
      if (!pending) pending = Promise.resolve().then(() => execute(queryScript)).then(parsePortOutput).finally(() => { pending = null; });
      return pending;
    }
  };
}

module.exports = { queryScript, parsePortOutput, createPortService };
