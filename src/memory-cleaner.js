const { execFile } = require('node:child_process');

const scanScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WindowProbe {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static System.Collections.Generic.HashSet<int> PidsWithWindows() {
    var result = new System.Collections.Generic.HashSet<int>();
    EnumWindows((hWnd, extra) => {
      if (!IsWindowVisible(hWnd)) return true;
      var title = new StringBuilder(256); GetWindowText(hWnd, title, title.Capacity);
      if (String.IsNullOrWhiteSpace(title.ToString().Trim())) return true;
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid != 0) result.Add((int)pid);
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
$windows = [WindowProbe]::PidsWithWindows()
$processes = Get-Process | Select-Object Id,ProcessName,WorkingSet,Description
$ownerMap = @{}
tasklist /v /fo csv /nh | ConvertFrom-Csv -Header @('Image','Pid','Session','SessionNum','Memory','Status','User','Cpu','Window') | ForEach-Object {
  $user = $_.User
  if ($user -eq '暂缺' -or $user -eq 'N/A' -or [string]::IsNullOrWhiteSpace($user)) { $user = $null }
  $ownerMap[[int]$_.Pid] = $user
}
$processes | ForEach-Object {
  $description = $_.Description
  if ([string]::IsNullOrWhiteSpace($description)) { $description = $null }
  [pscustomobject]@{ ProcessId=$_.Id; Name=$_.ProcessName; WorkingSetSize=[long]$_.WorkingSet; HasWindow=$windows.Contains([int]$_.Id); User=$ownerMap[$_.Id]; Description=$description }
} | ConvertTo-Json -Compress -Depth 2
`;

function encodedArgs(script) { return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]; }

function runScan(script = scanScript) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', encodedArgs(script), { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(error.killed ? '内存扫描超时，请刷新重试' : `内存扫描失败：${stderr.trim() || error.message}`)); return; }
      resolve(stdout.trim());
    });
  });
}

function killProcessWindows(processId) {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(processId), '/F'], { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`结束进程失败：${stderr.trim() || error.message}`)); return; }
      resolve(stdout.trim());
    });
  });
}

function parseProcessOutput(output) {
  if (!output || !String(output).trim()) return [];
  let parsed;
  try { parsed = JSON.parse(output); } catch (error) { throw new Error(`内存扫描返回无效数据: ${error.message}`); }
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((item) => {
      const processId = Number.isInteger(item?.ProcessId) && item.ProcessId > 0 ? item.ProcessId : null;
      const workingSetSize = Number(item?.WorkingSetSize);
      if (!processId || !Number.isFinite(workingSetSize) || workingSetSize < 0) return null;
      return {
        processId,
        processName: String(item?.Name || '未知进程'),
        memoryBytes: Math.floor(workingSetSize),
        hasWindow: Boolean(item?.HasWindow),
        user: typeof item?.User === 'string' && item.User.trim() ? item.User : null,
        description: typeof item?.Description === 'string' && item.Description.trim() ? item.Description : null
      };
    })
    .filter(Boolean);
}

const SAFE_HINTS = [
  { pattern: /unzip|7z|bandizip|winrar/i, reason: '压缩包解压完成后的辅助进程' },
  { pattern: /clipchamp|photoshop|lightroom|premiere|davinci|blender|vegas|keyshot|vray|lumion/i, reason: '大型创作软件，空闲时占用大量内存' },
  { pattern: /electron|msedge|chrome|firefox|brave|opera|wechat|weixin|qq|dingtalk|feishu|slack|teams|discord|notion|obsidian/i, reason: '聊天、办公或浏览器进程，空闲时内存占用较高' },
  { pattern: /steam|epic|origin|battle\.net|uplay|riotclient|wegame|nvidia geforce experience|adobe|onedrive|dropbox|baidu|aliwangwang|qqdownload|thunder|idfantom|xunlei/i, reason: '下载、网盘或客户端常驻进程，通常可暂停' }
];

function classifyProcess(item) {
  const name = String(item.processName || '');
  const lower = name.toLowerCase();
  if (/^system$|^registry$|^csrss\.exe$|^wininit\.exe$|^winlogon\.exe$|^services\.exe$|^lsass\.exe$|^smss\.exe$|^svchost\.exe$|^dwm\.exe$|^fontdrvhost\.exe$|^audiodg\.exe$|^conhost\.exe$/.test(lower)) return { level: 'protected', label: '系统关键进程', reason: 'Windows 核心组件，结束可能导致系统不稳定' };
  if (/^explorer\.exe$/.test(lower)) return { level: 'protected', label: '桌面进程', reason: 'Explorer 提供桌面和任务栏，结束会黑屏' };
  if (/^zhuomiantools\.exe$|^electron\.exe$/.test(lower)) return { level: 'protected', label: '当前应用', reason: '桌面工具箱自身进程，不能自行结束' };
  if (/^taskmgr\.exe$|^procexp\.exe$|^procmon\.exe$|^perfmon\.exe$/.test(lower)) return { level: 'protected', label: '系统监控工具', reason: '正在监视系统状态，结束会影响诊断' };
  if (item.hasWindow === false) return { level: 'safe', label: '后台驻留', reason: '当前没有打开的窗口，通常是关闭应用后残留的后台进程' };
  for (const hint of SAFE_HINTS) {
    if (hint.pattern.test(name)) return { level: 'safe', label: '可安全停止', reason: hint.reason };
  }
  if (item.hasWindow === false) return { level: 'safe', label: '后台驻留', reason: '当前没有打开的窗口，通常是关闭应用后残留的后台进程' };
  return { level: 'review', label: '建议人工确认', reason: '进程有可见窗口或用途未知，请确认后再停止' };
}

function buildScanResult(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const item = { ...classifyProcess(row), ...row };
    const existing = grouped.get(item.processName);
    if (existing) {
      existing.memoryBytes += item.memoryBytes;
      existing.instances.push({ processId: item.processId, hasWindow: item.hasWindow });
      if (item.user && !existing.users.includes(item.user)) existing.users.push(item.user);
      if (item.description && !existing.descriptions.includes(item.description)) existing.descriptions.push(item.description);
      if (item.level === 'safe' && item.hasWindow && !existing.safeReason) existing.safeReason = item.reason;
      continue;
    }
    grouped.set(item.processName, { ...item, instances: [{ processId: item.processId, hasWindow: item.hasWindow }], users: item.user ? [item.user] : [], descriptions: item.description ? [item.description] : [], safeReason: item.level === 'safe' && item.hasWindow ? item.reason : null });
  }
  for (const group of grouped.values()) {
    if (group.level === 'safe' && group.instances.some((instance) => instance.hasWindow)) {
      group.label = '可安全停止';
      if (group.safeReason) group.reason = group.safeReason;
    }
    delete group.safeReason;
  }
  const levelOrder = { safe: 0, review: 1, protected: 2 };
  const results = [...grouped.values()].sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || b.memoryBytes - a.memoryBytes);
  const safeCount = results.filter((item) => item.level === 'safe').length;
  const safeBytes = results.filter((item) => item.level === 'safe').reduce((sum, item) => sum + item.memoryBytes, 0);
  return { results, summary: { safeCount, safeBytes, total: results.length } };
}

function createMemoryCleanerService({ executeScan = runScan, executeKill = killProcessWindows, platform = process.platform, selfPid = process.pid } = {}) {
  let pending;
  return {
    scan() {
      if (platform !== 'win32') return Promise.reject(new Error('内存清理工具仅支持 Windows'));
      if (!pending) pending = Promise.resolve().then(() => executeScan(scanScript)).then(parseProcessOutput).then(buildScanResult).finally(() => { pending = null; });
      return pending;
    },
    kill(processId) {
      if (platform !== 'win32') return Promise.reject(new Error('内存清理工具仅支持 Windows'));
      if (!Number.isInteger(processId) || processId <= 0) return Promise.reject(new Error('无效的进程 ID'));
      if (processId === selfPid) return Promise.reject(new Error('不能结束桌面工具箱自身进程'));
      return executeKill(processId).then(() => processId);
    }
  };
}

module.exports = { scanScript, parseProcessOutput, classifyProcess, buildScanResult, createMemoryCleanerService };
