const { execFile, spawnSync } = require('node:child_process');

const nativeCode = `
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class WindowInfo { public string Handle; public string Title; public int ProcessId; public string ProcessName; public bool Topmost; }
public static class WindowPin {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  public static WindowInfo[] List(int excludedProcessId) {
    var result = new List<WindowInfo>();
    EnumWindows((hWnd, extra) => {
      if (!IsWindowVisible(hWnd)) return true;
      var title = new StringBuilder(1024); GetWindowText(hWnd, title, title.Capacity);
      var text = title.ToString().Trim(); if (String.IsNullOrWhiteSpace(text)) return true;
      uint pid; GetWindowThreadProcessId(hWnd, out pid); if (pid == excludedProcessId) return true;
      if (text.Contains("桌面工具箱") || text.Contains("快速便签")) return true;
      string name = "未知程序"; try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
      var style = GetWindowLong(hWnd, -20);
      result.Add(new WindowInfo { Handle = hWnd.ToInt64().ToString(), Title = text, ProcessId = (int)pid, ProcessName = name, Topmost = (style & 0x8) != 0 });
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static bool SetTopmost(long handle, bool enabled) {
    var window = new IntPtr(handle);
    return IsWindow(window) && SetWindowPos(window, new IntPtr(enabled ? -1 : -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
  }
}
`;
const header = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n$code = @'\n${nativeCode}\n'@\nAdd-Type $code -ErrorAction Stop\n`;
function listScript(pid) { return `${header}[WindowPin]::List(${pid}) | ConvertTo-Json -Compress -Depth 3`; }
function pinScript(handle, enabled) { return `${header}[WindowPin]::SetTopmost([Int64]${handle}, $${enabled})`; }
function encodedArgs(script) { return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]; }
function run(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', encodedArgs(script), { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message)); else resolve(stdout.trim());
    });
  });
}
function runSync(script) { return spawnSync('powershell.exe', encodedArgs(script), { windowsHide: true, timeout: 5000 }); }
function validHandle(handle) { return typeof handle === 'string' && /^[1-9]\d{0,18}$/.test(handle) && BigInt(handle) <= 9223372036854775807n; }

function createExternalWindowService({ execute = run, executeSync = runSync, selfPid = process.pid } = {}) {
  const pinned = new Set();
  async function list() {
    const output = await execute(listScript(selfPid));
    const parsed = output ? JSON.parse(output) : [];
    const windows = (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item && validHandle(item.Handle));
    const handles = new Set(windows.map((item) => item.Handle));
    for (const handle of pinned) if (!handles.has(handle)) pinned.delete(handle);
    return windows.map((item) => ({ handle: item.Handle, title: item.Title, processId: item.ProcessId, processName: item.ProcessName, topmost: item.Topmost, managed: pinned.has(item.Handle) }));
  }
  async function toggle(handle, enabled) {
    if (!validHandle(handle) || typeof enabled !== 'boolean') throw new Error('无效的窗口操作');
    if (!(await list()).some((item) => item.handle === handle)) throw new Error('窗口已关闭，请刷新列表');
    if ((await execute(pinScript(handle, enabled))).toLowerCase() !== 'true') throw new Error('无法修改窗口置顶状态');
    if (enabled) pinned.add(handle); else pinned.delete(handle);
    return { handle, enabled };
  }
  function release() { for (const handle of pinned) executeSync(pinScript(handle, false)); pinned.clear(); }
  return { list, toggle, release };
}
module.exports = { createExternalWindowService, listScript, pinScript };
