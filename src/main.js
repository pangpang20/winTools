const { app, BrowserWindow, ipcMain, screen, clipboard, globalShortcut, Notification, desktopCapturer, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const QRCode = require('qrcode');
const mammoth = require('mammoth');
const { createExternalWindowService } = require('./external-windows');
const { findWindowSource, withWindowThumbnails } = require('./window-thumbnails');
const { createPortService } = require('./ports');

let mainWindow;
let widgetWindow;
const noteWindows = new Map();
let widgetAlwaysOnTop = true;
let clipboardTimer;
let lastClipboardText = '';
let clipboardEnabled = true;
let clipboardHistory = [];
const reminderTimers = new Map();
const externalWindows = createExternalWindowService();
const ports = createPortService();
const defaultShortcuts = { showToolbox: 'Control+Alt+Space', startTimer: 'Control+Alt+T', newNote: 'Control+Alt+N', openClipboard: 'Control+Alt+V', screenshot: 'Control+Alt+A', colorPicker: 'Control+Alt+C' };
let shortcuts = { ...defaultShortcuts };

function dataPath() { return path.join(app.getPath('userData'), 'toolbox-data.json'); }
function readData() {
  try {
    const data = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    clipboardEnabled = data.clipboardEnabled !== false;
    clipboardHistory = Array.isArray(data.clipboardHistory) ? data.clipboardHistory : [];
    shortcuts = { ...defaultShortcuts, ...(data.shortcuts || {}) };
  } catch { /* first run */ }
}
function writeData() {
  try { fs.mkdirSync(path.dirname(dataPath()), { recursive: true }); fs.writeFileSync(dataPath(), JSON.stringify({ clipboardEnabled, clipboardHistory, shortcuts }), 'utf8'); }
  catch (error) { console.error('Failed to save toolbox data', error); }
}
function send(channel, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); }

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({ width: Math.min(width, 1200, Math.max(640, width - 120)), height: Math.min(height, 820, Math.max(480, height - 90)), minWidth: Math.min(640, width), minHeight: Math.min(480, height), show: false, frame: false, backgroundColor: '#0b0d12', titleBarStyle: 'hidden', resizable: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createNoteWindow(note) {
  const existing = noteWindows.get(note.id);
  if (existing && !existing.isDestroyed()) { existing.focus(); return true; }
  const noteWindow = new BrowserWindow({
    width: 330,
    height: 270,
    minWidth: 250,
    minHeight: 190,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    parent: mainWindow || undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  noteWindows.set(note.id, noteWindow);
  noteWindow.loadFile(path.join(__dirname, 'note.html'));
  noteWindow.webContents.once('did-finish-load', () => noteWindow.webContents.send('note:state', note));
  noteWindow.on('closed', () => { noteWindows.delete(note.id); send('note:visibility', { id: note.id, visible: false }); });
  return true;
}

function pruneClipboard() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  clipboardHistory = clipboardHistory.filter((item) => item.pinned || item.createdAt >= cutoff);
  while (clipboardHistory.length > 200) { const index = clipboardHistory.findIndex((item) => !item.pinned); if (index < 0) break; clipboardHistory.splice(index, 1); }
}
function watchClipboard() {
  clearInterval(clipboardTimer);
  clipboardTimer = setInterval(() => {
    if (!clipboardEnabled) return;
    const text = clipboard.readText().trim();
    if (!text || text === lastClipboardText) return;
    lastClipboardText = text;
    clipboardHistory = clipboardHistory.filter((item) => item.text !== text);
    clipboardHistory.unshift({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text, createdAt: Date.now(), pinned: false });
    pruneClipboard(); writeData(); send('clipboard:updated', clipboardHistory);
  }, 700);
}

function registerShortcuts(nextShortcuts = shortcuts) {
  const previous = { ...shortcuts };
  globalShortcut.unregisterAll();
  for (const [name, accelerator] of Object.entries(nextShortcuts)) {
    if (!accelerator) continue;
    const ok = globalShortcut.register(accelerator, () => { if (name === 'showToolbox') { mainWindow?.show(); mainWindow?.focus(); } else send('shortcut:triggered', name); });
    if (!ok) {
      globalShortcut.unregisterAll();
      for (const [oldName, oldAccelerator] of Object.entries(previous)) if (oldAccelerator) globalShortcut.register(oldAccelerator, () => { if (oldName === 'showToolbox') { mainWindow?.show(); mainWindow?.focus(); } else send('shortcut:triggered', oldName); });
      return { ok: false, conflict: name, shortcuts: previous };
    }
  }
  shortcuts = { ...defaultShortcuts, ...nextShortcuts }; writeData(); return { ok: true, shortcuts };
}
function captureScreen() { return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size }).then((sources) => sources[0]?.thumbnail?.toDataURL() || null); }
async function listExternalWindowsWithThumbnails() {
  const windows = await externalWindows.list();
  try {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 240, height: 135 } });
    return withWindowThumbnails(windows, sources);
  } catch (error) {
    console.error('Failed to capture window thumbnails', error);
    return windows.map((window) => ({ ...window, thumbnail: null }));
  }
}
async function previewExternalWindow(handle) {
  if (typeof handle !== 'string' || !(await externalWindows.list()).some((window) => window.handle === handle)) throw new Error('窗口已关闭，请刷新列表');
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 800 } });
  return findWindowSource(sources, handle)?.thumbnail.toDataURL() || null;
}

app.whenReady().then(() => { readData(); pruneClipboard(); writeData(); createWindow(); watchClipboard(); registerShortcuts(shortcuts); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('will-quit', () => { externalWindows.release(); globalShortcut.unregisterAll(); clearInterval(clipboardTimer); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('window:set-always-on-top', (_event, enabled) => { widgetAlwaysOnTop = Boolean(enabled); widgetWindow?.setAlwaysOnTop(widgetAlwaysOnTop, 'floating'); return widgetAlwaysOnTop; });
ipcMain.handle('window:set-opacity', (_event, value) => { const opacity = Math.min(1, Math.max(0.5, Number(value) || 1)); mainWindow?.setOpacity(opacity); widgetWindow?.setOpacity(opacity); return opacity; });
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-always-on-top', () => widgetAlwaysOnTop);
ipcMain.handle('external-windows:list', listExternalWindowsWithThumbnails);
ipcMain.handle('external-windows:preview', (_event, handle) => previewExternalWindow(handle));
ipcMain.handle('external-windows:toggle-pin', (_event, { handle, enabled }) => externalWindows.toggle(handle, enabled));
ipcMain.handle('ports:list', async () => {
  if (process.env.PORTS_TEST_ERROR_FILE) {
    try {
      const simulated = JSON.parse(fs.readFileSync(process.env.PORTS_TEST_ERROR_FILE, 'utf8'));
      if (simulated.delayMs) await new Promise((resolve) => setTimeout(resolve, simulated.delayMs));
      if (simulated.error) throw new Error(simulated.error);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return ports.list();
});

ipcMain.handle('widget:toggle', () => {
  if (widgetWindow) { widgetWindow.close(); return false; }
  widgetWindow = new BrowserWindow({ width: 570, height: 160, minWidth: 340, minHeight: 125, frame: false, transparent: true, center: true, resizable: true, alwaysOnTop: widgetAlwaysOnTop, skipTaskbar: true, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  widgetWindow.loadFile(path.join(__dirname, 'widget.html'));
  widgetWindow.on('closed', () => { widgetWindow = null; send('widget:visibility', false); }); return true;
});
ipcMain.on('widget:state', (_event, state) => { if (!widgetWindow || widgetWindow.isDestroyed()) return; const size = Math.min(144, Math.max(56, Number(state.fontSize) || 96)); const bounds = widgetWindow.getBounds(); const width = Math.min(850, Math.max(390, Math.round(size * 5.6 + 90))); if (bounds.width !== width) widgetWindow.setBounds({ ...bounds, width }); widgetWindow.webContents.send('widget:state', state); });
ipcMain.on('widget:command', (_event, command) => send('widget:command', command));
ipcMain.on('widget:ready', (event) => { send('widget:request-state'); event.sender.send('widget:visibility', true); });
ipcMain.on('widget:close', () => widgetWindow?.close());

ipcMain.handle('notes:open', (_event, note) => createNoteWindow(note));
ipcMain.on('notes:update', (event, note) => {
  for (const [id, window] of noteWindows) {
    if (!window.isDestroyed() && id === note.id && event.sender !== window.webContents) window.webContents.send('note:state', note);
  }
  send('notes:updated', note);
});
ipcMain.on('notes:close', (_event, id) => noteWindows.get(id)?.close());

ipcMain.handle('clipboard:get', () => ({ enabled: clipboardEnabled, history: clipboardHistory }));
ipcMain.handle('clipboard:set-enabled', (_event, enabled) => { clipboardEnabled = Boolean(enabled); writeData(); return clipboardEnabled; });
ipcMain.handle('clipboard:copy', (_event, text) => { clipboard.writeText(String(text || '')); lastClipboardText = String(text || ''); return true; });
ipcMain.handle('clipboard:clear', () => { clipboardHistory = clipboardHistory.filter((item) => item.pinned); writeData(); send('clipboard:updated', clipboardHistory); return clipboardHistory; });
ipcMain.handle('clipboard:pin', (_event, id) => { const item = clipboardHistory.find((entry) => entry.id === id); if (item) item.pinned = !item.pinned; pruneClipboard(); writeData(); send('clipboard:updated', clipboardHistory); return clipboardHistory; });
ipcMain.handle('shortcuts:get', () => shortcuts);
ipcMain.handle('shortcuts:save', (_event, next) => registerShortcuts(next));
ipcMain.handle('system:capture-screen', captureScreen);
ipcMain.handle('qr:generate', (_event, text) => QRCode.toDataURL(String(text || ''), { width: 260, margin: 2, color: { dark: '#10151d', light: '#ffffff' } }));
ipcMain.handle('tts:open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择要朗读的文档', properties: ['openFile'], filters: [{ name: '可朗读文档', extensions: ['txt', 'docx'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const extension = path.extname(filePath).toLowerCase();
  const text = extension === '.docx' ? (await mammoth.extractRawText({ path: filePath })).value : fs.readFileSync(filePath, 'utf8');
  return { name: path.basename(filePath), text: text.replace(/\r\n/g, '\n').trim() };
});
ipcMain.handle('system:notify', (_event, { title, body }) => { if (Notification.isSupported()) new Notification({ title, body }).show(); return true; });
ipcMain.handle('reminder:schedule', (_event, reminder) => { const delay = Math.max(0, Number(reminder.at) - Date.now()); if (reminderTimers.has(reminder.id)) clearTimeout(reminderTimers.get(reminder.id)); const timer = setTimeout(() => { if (Notification.isSupported()) new Notification({ title: '桌面工具箱提醒', body: reminder.message }).show(); send('reminder:fired', reminder.id); reminderTimers.delete(reminder.id); }, delay); reminderTimers.set(reminder.id, timer); return true; });
ipcMain.handle('reminder:cancel', (_event, id) => { if (reminderTimers.has(id)) { clearTimeout(reminderTimers.get(id)); reminderTimers.delete(id); } return true; });
