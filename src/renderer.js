const DEFAULT_STATE = { mode: 'stopwatch', elapsedMs: 0, countdownMs: 25 * 60 * 1000, running: false, opacity: 100, fontSize: 96, color: '#f4f6fb', colorName: '极夜白', alwaysOnTop: false };
let state;
try { state = { ...DEFAULT_STATE, ...(JSON.parse(localStorage.getItem('zhuomiantools.timer') || 'null') || {}) }; } catch { state = { ...DEFAULT_STATE }; }
let lastTickAt = 0;
let animationFrame = 0;
let notes = JSON.parse(localStorage.getItem('zhuomiantools.notes') || '[]').map((note) => ({ id: note.id || `note-${Date.now()}-${Math.random().toString(16).slice(2)}`, text: note.text || '', color: note.color || '#f9d77e' }));
localStorage.setItem('zhuomiantools.notes', JSON.stringify(notes));
let clipboardItems = [];
let pomodoroRemaining = 25 * 60 * 1000;
let pomodoroRunning = false;
let pomodoroLastTick = 0;
let pomodoroFrame = 0;
let currentTool = 'timer';
let windowPreviewRequest = 0;
let portItems = [];
let portsLoading = false;
let portsError = '';
let portsUpdatedAt = '';

const $ = (id) => document.getElementById(id);
const timerDisplay = $('timerDisplay');
const timerMetaValue = $('timerMetaValue');
const timerMetaLabel = $('timerMetaLabel');
const startButton = $('startButton');
const startButtonLabel = $('startButtonLabel');
const runningState = $('runningState');
const progressBar = $('progressBar');
const stopwatchMode = $('stopwatchMode');
const countdownMode = $('countdownMode');
const opacityRange = $('opacityRange');
const opacityValue = $('opacityValue');
const fontSizeRange = $('fontSizeRange');
const fontSizeValue = $('fontSizeValue');
const alwaysOnTop = $('alwaysOnTop');
const colorValue = $('colorValue');

function saveTimer() { localStorage.setItem('zhuomiantools.timer', JSON.stringify({ ...state, running: false })); }
function formatTime(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':'); }
function shortTime(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function currentTime() { return state.mode === 'stopwatch' ? state.elapsedMs : state.countdownMs; }
function toast(message) { const element = document.createElement('div'); element.className = 'flash-message'; element.textContent = message; document.body.appendChild(element); setTimeout(() => element.remove(), 2400); }

function renderTimer() {
  const current = currentTime();
  timerDisplay.textContent = formatTime(current);
  timerMetaValue.textContent = formatTime(state.mode === 'stopwatch' ? state.elapsedMs : Math.max(0, 25 * 60 * 1000 - state.countdownMs));
  timerMetaLabel.textContent = state.mode === 'stopwatch' ? '累计时长' : '已专注';
  document.documentElement.style.setProperty('--display-size', `${state.fontSize}px`);
  document.documentElement.style.setProperty('--display-color', state.color);
  opacityRange.value = String(state.opacity); opacityValue.textContent = `${state.opacity}%`;
  fontSizeRange.value = String(state.fontSize); fontSizeValue.textContent = `${state.fontSize} px`;
  alwaysOnTop.checked = Boolean(state.alwaysOnTop); colorValue.textContent = state.colorName;
  opacityRange.style.setProperty('--range-progress', `${((state.opacity - 50) / 50) * 100}%`);
  fontSizeRange.style.setProperty('--range-progress', `${((state.fontSize - 56) / 88) * 100}%`);
  startButtonLabel.textContent = state.running ? '暂停计时' : '开始计时'; startButton.querySelector('.play-icon').textContent = state.running ? 'Ⅱ' : '▶';
  runningState.classList.toggle('live', state.running); runningState.classList.toggle('done', state.mode === 'countdown' && current <= 0);
  runningState.innerHTML = state.mode === 'countdown' && current <= 0 ? '<i></i>时间到' : state.running ? '<i></i>正在计时' : '<i></i>准备就绪';
  progressBar.style.width = `${state.mode === 'countdown' ? Math.min(100, Math.max(0, ((25 * 60 * 1000 - state.countdownMs) / (25 * 60 * 1000)) * 100)) : 0}%`;
  document.querySelectorAll('.color-swatch').forEach((swatch) => swatch.classList.toggle('selected', swatch.dataset.color === state.color));
  window.desktopAPI.sendWidgetState?.({ mode: state.mode, valueMs: current, running: state.running, startedAt: Date.now(), fontSize: state.fontSize, color: state.color });
}
function timerTick(timestamp) {
  if (!state.running) return;
  if (!lastTickAt) lastTickAt = timestamp;
  const delta = timestamp - lastTickAt; lastTickAt = timestamp;
  if (state.mode === 'stopwatch') state.elapsedMs += delta;
  else { state.countdownMs = Math.max(0, state.countdownMs - delta); if (state.countdownMs <= 0) { state.running = false; lastTickAt = 0; window.desktopAPI.notify('计时结束', '本次倒计时已经完成。'); } }
  renderTimer(); if (state.running) animationFrame = requestAnimationFrame(timerTick);
}
function setRunning(next) { state.running = next; lastTickAt = 0; if (next) animationFrame = requestAnimationFrame(timerTick); else cancelAnimationFrame(animationFrame); saveTimer(); renderTimer(); }
function switchMode(mode) { if (state.running) setRunning(false); state.mode = mode; stopwatchMode.classList.toggle('active', mode === 'stopwatch'); countdownMode.classList.toggle('active', mode === 'countdown'); stopwatchMode.setAttribute('aria-selected', String(mode === 'stopwatch')); countdownMode.setAttribute('aria-selected', String(mode === 'countdown')); saveTimer(); renderTimer(); }

function selectTool(tool) {
  currentTool = tool;
  const titles = { timer: ['计时器', '把时间放在桌面上，专注当前这一件事。'], pomodoro: ['番茄钟', '用清晰的专注周期，保持节奏。'], notes: ['快速便签', '把临时想法留在桌面，稍后再处理。'], clipboard: ['剪贴板历史', '找回最近复制过的文本。'], capture: ['截图与取色', '快速截取屏幕，提取需要的颜色。'], converter: ['转换器', '常用单位与时间格式即时换算。'], reminders: ['闹钟与提醒', '把要记住的事交给桌面。'], qr: ['二维码', '生成可分享的文本二维码。'], tts: ['文本朗读', '把 TXT 和 DOCX 文件转换成语音播放。'], windowPin: ['窗口置顶', '选择一个窗口，让它始终显示在最前端。'], ports: ['端口进程', '查看 Windows 正在监听的端口、程序路径和启动命令行。'], settings: ['快捷键设置', '为常用工具配置全局快捷键。'] };
  $('pageTitle').textContent = titles[tool][0]; $('pageDescription').textContent = titles[tool][1];
  $('timerEyebrow').hidden = tool !== 'timer';
  $('timerHeadingActions').hidden = tool !== 'timer';
  document.querySelectorAll('[data-tool]').forEach((button) => { const active = button.dataset.tool === tool; button.classList.toggle('active', active); button.toggleAttribute('aria-current', active); });
  document.querySelectorAll('.tool-view, .generic-view').forEach((view) => { const visible = tool === 'timer' ? ['timerView', 'quickStartView'].includes(view.id) : view.id === `${tool}View`; view.hidden = !visible; });
  if (tool === 'notes') renderNotes(); if (tool === 'clipboard') renderClipboard(); if (tool === 'converter') setupConverter(); if (tool === 'windowPin') renderExternalWindows(); if (tool === 'ports') loadPorts(); if (tool === 'settings') renderShortcuts();
}

function renderPorts() {
  const list = $('portList');
  list.replaceChildren();
  $('portTableWrap').setAttribute('aria-busy', String(portsLoading));
  if (portsLoading || portsError) {
    const message = portsLoading ? '正在获取端口、进程路径和命令行，请稍候…' : `${portsError}。请点击“刷新列表”重试。`;
    $('portStatus').textContent = portsLoading ? '正在查询…' : '获取失败';
    showPortMessage(message, Boolean(portsError));
    return;
  }
  const query = $('portSearch').value.trim();
  const direction = $('portSort').value;
  const factor = direction === 'desc' ? -1 : 1;
  const items = portItems.filter((item) => !query || String(item.port).includes(query)).sort((a, b) => (a.port - b.port) * factor || a.protocol.localeCompare(b.protocol) || a.address.localeCompare(b.address));
  $('portStatus').textContent = `显示 ${items.length} / ${portItems.length} 条记录${portsUpdatedAt ? ` · 更新于 ${portsUpdatedAt}` : ''}`;
  if (!items.length) { showPortMessage(query ? '没有匹配的端口，请修改或清空搜索内容。' : '未发现 TCP 监听端口或 UDP 绑定端口。'); return; }
  for (const item of items) {
    const row = document.createElement('tr');
    const cells = [item.protocol, item.address, String(item.port), item.protocol === 'TCP' ? '监听' : '已绑定', item.processId == null ? '未知' : String(item.processId), item.processName, item.path || '无法读取（系统 / 权限不足 / 已退出）', item.commandLine || '无法读取（系统 / 权限不足 / 已退出）'];
    cells.forEach((value, index) => { const cell = document.createElement('td'); cell.textContent = value; if (index === 2) cell.className = 'port-number'; if (index === 6 || index === 7) { cell.className = index === 6 ? 'port-path' : 'port-command-line'; cell.title = value; } row.appendChild(cell); });
    list.appendChild(row);
  }
}

function showPortMessage(message, error = false) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 8; cell.className = error ? 'port-empty port-error' : 'port-empty'; cell.textContent = message;
  row.appendChild(cell); $('portList').appendChild(row);
}

async function loadPorts() {
  if (portsLoading) return;
  const refresh = $('refreshPorts');
  portsLoading = true; portsError = ''; refresh.disabled = true; renderPorts();
  try {
    portItems = await window.desktopAPI.listPorts();
    portsUpdatedAt = new Date().toLocaleTimeString();
  } catch (error) {
    portItems = []; portsError = error.message || '获取端口失败';
  } finally { portsLoading = false; refresh.disabled = false; renderPorts(); }
}

async function openWindowPreview(item) {
  const dialog = $('windowPreviewDialog');
  const request = ++windowPreviewRequest;
  $('windowPreviewTitle').textContent = item.title;
  $('windowPreviewImage').src = item.thumbnail;
  dialog.showModal();
  try {
    const image = await window.desktopAPI.previewExternalWindow(item.handle);
    if (dialog.open && request === windowPreviewRequest && image) $('windowPreviewImage').src = image;
  } catch (error) { if (dialog.open && request === windowPreviewRequest) toast(error.message || '无法获取窗口预览'); }
}

async function renderExternalWindows() {
  const list = $('windowList');
  list.textContent = '正在获取窗口...';
  $('refreshWindowList').disabled = true;
  try {
    const windows = await window.desktopAPI.listExternalWindows();
    if (currentTool !== 'windowPin') return;
    list.replaceChildren();
    if (!windows.length) { list.innerHTML = '<div class="empty-state"><strong>没有可操作的窗口</strong><span>打开目标程序后刷新列表</span></div>'; return; }
    for (const item of windows) {
      const row = document.createElement('div'); row.className = 'window-pin-row';
      const preview = document.createElement('button'); preview.className = 'window-pin-thumbnail'; preview.type = 'button';
      if (item.thumbnail) {
        const image = document.createElement('img'); image.src = item.thumbnail; image.alt = '';
        preview.appendChild(image); preview.title = '放大查看窗口';
        preview.setAttribute('aria-label', `放大查看 ${item.title} 的窗口缩略图`);
        preview.addEventListener('click', () => openWindowPreview(item));
      } else {
        preview.textContent = '无法预览'; preview.disabled = true;
        preview.setAttribute('aria-label', `${item.title} 无法预览`);
      }
      const details = document.createElement('div'); details.className = 'window-pin-details';
      const title = document.createElement('strong'); title.className = 'window-pin-title'; title.textContent = item.title;
      const process = document.createElement('span'); process.className = 'window-pin-process'; process.textContent = `${item.processName} · PID ${item.processId}`;
      details.append(title, process);
      const action = document.createElement('button'); action.className = item.topmost ? 'utility-button' : 'primary-button'; action.type = 'button'; action.textContent = item.topmost ? '取消置顶' : '置顶';
      action.setAttribute('aria-label', `${item.topmost ? '取消置顶' : '置顶'} ${item.title}`);
      action.addEventListener('click', async () => {
        action.disabled = true;
        try { await window.desktopAPI.toggleExternalWindowPin(item.handle, !item.topmost); toast(item.topmost ? '已取消置顶' : '窗口已置顶'); await renderExternalWindows(); }
        catch (error) { toast(error.message || '窗口操作失败'); action.disabled = false; }
      });
      row.append(preview, details, action); list.appendChild(row);
    }
  } catch (error) { list.textContent = error.message || '获取窗口失败'; }
  finally { $('refreshWindowList').disabled = false; }
}

function renderNotes() {
  const grid = $('notesGrid'); grid.innerHTML = '';
  notes.forEach((note, index) => { const card = document.createElement('article'); card.className = 'note-card'; card.style.background = note.color; card.innerHTML = `<textarea aria-label="便签内容"></textarea><div class="note-card-footer"><span>自动保存</span><div class="note-card-actions"><button class="note-popout" type="button" title="弹出便签">□ 弹出</button><button class="note-delete" type="button">删除</button></div></div>`; const textarea = card.querySelector('textarea'); textarea.value = note.text; textarea.addEventListener('input', () => { notes[index].text = textarea.value; localStorage.setItem('zhuomiantools.notes', JSON.stringify(notes)); window.desktopAPI.updateNoteWindow(notes[index]); }); card.querySelector('.note-popout').addEventListener('click', () => window.desktopAPI.openNoteWindow(note)); card.querySelector('.note-delete').addEventListener('click', () => { window.desktopAPI.closeNoteWindow(note.id); notes.splice(index, 1); localStorage.setItem('zhuomiantools.notes', JSON.stringify(notes)); renderNotes(); }); grid.appendChild(card); });
  if (!notes.length) grid.innerHTML = '<div class="empty-state"><span class="empty-icon">✎</span><strong>还没有便签</strong><span>点击右上角新建一张</span></div>';
}
function addNote(open = false) { const note = { id: `note-${Date.now()}-${Math.random().toString(16).slice(2)}`, text: '', color: ['#f9d77e', '#9edcf4', '#b5e6c3'][notes.length % 3] }; notes.unshift(note); localStorage.setItem('zhuomiantools.notes', JSON.stringify(notes)); renderNotes(); document.querySelector('#notesGrid textarea')?.focus(); if (open) window.desktopAPI.openNoteWindow(note); }

function renderClipboard() {
  const query = ($('clipboardSearch').value || '').toLowerCase(); const list = $('clipboardList'); list.innerHTML = '';
  const items = clipboardItems.filter((item) => item.text.toLowerCase().includes(query));
  if (!items.length) { list.innerHTML = '<div class="empty-state"><span class="empty-icon">⌘</span><strong>暂无剪贴板记录</strong><span>复制文本后会自动出现在这里</span></div>'; return; }
  items.forEach((item) => { const row = document.createElement('div'); row.className = 'clipboard-item'; row.innerHTML = `<div class="clipboard-text"></div><div class="clipboard-actions"><button class="mini-button copy" type="button">复制</button><button class="mini-button pin" type="button">${item.pinned ? '取消固定' : '固定'}</button></div>`; row.querySelector('.clipboard-text').textContent = item.text; row.querySelector('.copy').addEventListener('click', () => window.desktopAPI.copyClipboard(item.text).then(() => toast('已复制'))); row.querySelector('.pin').addEventListener('click', () => window.desktopAPI.pinClipboard(item.id)); list.appendChild(row); });
}

const units = { length: { units: ['米', '千米', '英尺', '英里'], rates: { 米: 1, 千米: 1000, 英尺: 0.3048, 英里: 1609.344 } }, weight: { units: ['克', '千克', '磅', '盎司'], rates: { 克: 1, 千克: 1000, 磅: 453.59237, 盎司: 28.3495 } }, temperature: { units: ['摄氏度', '华氏度', '开尔文'] }, timestamp: { units: ['Unix 秒', 'Unix 毫秒'], rates: { 'Unix 秒': 1, 'Unix 毫秒': .001 } }, size: { units: ['字节', 'KB', 'MB', 'GB'], rates: { 字节: 1, KB: 1024, MB: 1048576, GB: 1073741824 } } };
function setupConverter() { const config = units[$('converterType').value]; $('converterFrom').innerHTML = config.units.map((unit) => `<option>${unit}</option>`).join(''); $('converterTo').innerHTML = config.units.map((unit) => `<option>${unit}</option>`).join(''); updateConversion(); }
function updateConversion() { const type = $('converterType').value; const config = units[type]; const value = Number($('converterInput').value) || 0; const from = $('converterFrom').value; const to = $('converterTo').value; let result = value; if (type === 'temperature') { if (from === '摄氏度' && to === '华氏度') result = value * 9 / 5 + 32; else if (from === '华氏度' && to === '摄氏度') result = (value - 32) * 5 / 9; else if (from === '摄氏度' && to === '开尔文') result = value + 273.15; else if (from === '开尔文' && to === '摄氏度') result = value - 273.15; else if (from === '华氏度' && to === '开尔文') result = (value - 32) * 5 / 9 + 273.15; else if (from === '开尔文' && to === '华氏度') result = (value - 273.15) * 9 / 5 + 32; } else if (type === 'timestamp') { result = value * config.rates[from] / config.rates[to]; } else result = value * config.rates[from] / config.rates[to]; $('converterOutput').textContent = Number.isFinite(result) ? Number(result.toFixed(6)).toLocaleString() : '0'; }

function renderReminders() { const list = $('reminderList'); const stored = JSON.parse(localStorage.getItem('zhuomiantools.reminders') || '[]'); list.innerHTML = stored.length ? stored.map((item) => `<div class="reminder-item"><span>${item.message} · ${new Date(item.at).toLocaleString()}</span><button class="mini-button" data-id="${item.id}" type="button">取消</button></div>`).join('') : '<div class="empty-state"><span>还没有提醒</span></div>'; list.querySelectorAll('[data-id]').forEach((button) => button.addEventListener('click', () => { const id = button.dataset.id; window.desktopAPI.cancelReminder(id); localStorage.setItem('zhuomiantools.reminders', JSON.stringify(stored.filter((item) => item.id !== id))); renderReminders(); })); }
function addReminder() { const message = $('reminderMessage').value.trim() || '专注时间结束'; const at = Date.now() + Math.max(1, Number($('reminderMinutes').value) || 1) * 60000; const item = { id: `${Date.now()}`, message, at }; const stored = JSON.parse(localStorage.getItem('zhuomiantools.reminders') || '[]'); stored.push(item); localStorage.setItem('zhuomiantools.reminders', JSON.stringify(stored)); window.desktopAPI.scheduleReminder(item); $('reminderMessage').value = ''; renderReminders(); }

function renderShortcuts() { window.desktopAPI.getShortcuts().then((values) => { const labels = { showToolbox: '显示工具箱', startTimer: '开始 / 暂停计时', newNote: '新建便签', openClipboard: '打开剪贴板', screenshot: '截图', colorPicker: '取色器' }; const box = $('shortcutSettings'); box.innerHTML = Object.entries(labels).map(([key, label]) => `<div class="shortcut-row"><span>${label}</span><input class="shortcut-input" data-key="${key}" value="${values[key] || ''}" aria-label="${label}快捷键"></div>`).join('') + '<button class="primary-button shortcut-save" id="saveShortcuts" type="button">保存快捷键</button>'; box.querySelectorAll('.shortcut-input').forEach((input) => input.addEventListener('keydown', (event) => { event.preventDefault(); const parts = []; if (event.ctrlKey) parts.push('Control'); if (event.altKey) parts.push('Alt'); if (event.shiftKey) parts.push('Shift'); if (event.metaKey) parts.push('Super'); const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key; if (!['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) parts.push(key); input.value = [...new Set(parts)].join('+'); })); $('saveShortcuts').addEventListener('click', async () => { const next = {}; box.querySelectorAll('.shortcut-input').forEach((input) => { next[input.dataset.key] = input.value; }); const result = await window.desktopAPI.saveShortcuts(next); if (!result.ok) toast(`快捷键冲突：${result.conflict}`); else toast('快捷键已保存'); }); }); }

function renderPomodoro() { $('pomodoroTime').textContent = shortTime(pomodoroRemaining); $('pomodoroStart').textContent = pomodoroRunning ? '暂停专注' : '开始专注'; }
function pomodoroTick(timestamp) { if (!pomodoroRunning) return; if (!pomodoroLastTick) pomodoroLastTick = timestamp; pomodoroRemaining = Math.max(0, pomodoroRemaining - (timestamp - pomodoroLastTick)); pomodoroLastTick = timestamp; if (pomodoroRemaining <= 0) { pomodoroRunning = false; window.desktopAPI.notify('番茄钟完成', '该休息一下了。'); } renderPomodoro(); if (pomodoroRunning) pomodoroFrame = requestAnimationFrame(pomodoroTick); }

document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => selectTool(button.dataset.tool)));
$('refreshWindowList').addEventListener('click', renderExternalWindows);
$('refreshPorts').addEventListener('click', loadPorts);
$('portSearch').addEventListener('input', renderPorts);
$('portSort').addEventListener('change', renderPorts);
$('closeWindowPreview').addEventListener('click', () => $('windowPreviewDialog').close());
$('windowPreviewDialog').addEventListener('close', (event) => { if (!event.target.open) windowPreviewRequest++; });
$('windowPreviewDialog').addEventListener('click', (event) => { if (event.target === $('windowPreviewDialog')) event.target.close(); });
startButton.addEventListener('click', () => setRunning(!state.running)); $('resetButton').addEventListener('click', () => { setRunning(false); state.elapsedMs = 0; state.countdownMs = 25 * 60 * 1000; saveTimer(); renderTimer(); });
stopwatchMode.addEventListener('click', () => switchMode('stopwatch')); countdownMode.addEventListener('click', () => switchMode('countdown'));
opacityRange.addEventListener('input', async (event) => { state.opacity = Number(event.target.value); await window.desktopAPI.setOpacity(state.opacity / 100); renderTimer(); saveTimer(); });
fontSizeRange.addEventListener('input', (event) => { state.fontSize = Number(event.target.value); renderTimer(); saveTimer(); });
alwaysOnTop.addEventListener('change', async (event) => { state.alwaysOnTop = await window.desktopAPI.setAlwaysOnTop(event.target.checked); renderTimer(); saveTimer(); });
document.querySelectorAll('.color-swatch').forEach((swatch) => swatch.addEventListener('click', () => { state.color = swatch.dataset.color; state.colorName = swatch.dataset.name; renderTimer(); saveTimer(); }));
document.querySelectorAll('.preset-button').forEach((button) => button.addEventListener('click', () => { switchMode('countdown'); state.countdownMs = Number(button.dataset.minutes) * 60000; saveTimer(); renderTimer(); }));
$('minimizeButton').addEventListener('click', () => window.desktopAPI.minimize()); $('closeButton').addEventListener('click', () => window.desktopAPI.close());
$('widgetButton').addEventListener('click', async () => { const visible = await window.desktopAPI.toggleWidget(); $('widgetButtonLabel').textContent = visible ? '关闭浮窗' : '桌面浮窗'; if (visible) renderTimer(); });
$('newNoteButton').addEventListener('click', () => addNote(false)); $('openAllNotesButton').addEventListener('click', () => notes.forEach((note, index) => setTimeout(() => window.desktopAPI.openNoteWindow(note), index * 80))); $('clearClipboard').addEventListener('click', () => window.desktopAPI.clearClipboard()); $('clipboardSearch').addEventListener('input', renderClipboard); $('clipboardEnabled').addEventListener('change', (event) => window.desktopAPI.setClipboardEnabled(event.target.checked));
$('captureScreenButton').addEventListener('click', async () => {
  const dataUrl = await window.desktopAPI.captureScreen();
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => {
    captureCanvas.width = img.naturalWidth;
    captureCanvas.height = img.naturalHeight;
    captureCanvas.getContext('2d').drawImage(img, 0, 0);
    captureCanvas.hidden = false;
    const empty = $('capturePreview').querySelector('.empty-state');
    if (empty) empty.classList.add('hidden');
    const rect = captureCanvas.getBoundingClientRect();
    setLiveColor(sampleColorAt({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }) || '#7DD3FC');
  };
  img.src = dataUrl;
});
$('colorPickerInput').addEventListener('input', (event) => setLiveColor(event.target.value));

const captureCanvas = $('captureCanvas');
let recordedColors = JSON.parse(localStorage.getItem('zhuomiantools.captureColors') || '[]');
function hexToRgb(hex) { const parts = hex.match(/[A-Fa-f0-9]{2}/g); return parts ? parts.map((part) => parseInt(part, 16)).join(', ') : ''; }
function setLiveColor(hex) { hex = String(hex).toUpperCase(); $('liveColorPreview').style.background = hex; $('hexValue').textContent = hex; $('rgbValue').textContent = hexToRgb(hex); }
function renderRecordedColors() {
  const list = $('recordedColors');
  list.innerHTML = recordedColors.length
    ? recordedColors.map((hex, index) => '<li class="recorded-color"><span class="recorded-swatch" style="background:' + hex + '"></span><span class="recorded-hex">' + hex + '</span><button class="recorded-copy" type="button" data-hex="' + hex + '">复制</button></li>').join('')
    : '<li class="recorded-empty">暂无记录</li>';
  list.querySelectorAll('.recorded-copy').forEach((button) => button.addEventListener('click', () => window.desktopAPI.copyClipboard(button.dataset.hex).then(() => toast('颜色值已复制'))));
  localStorage.setItem('zhuomiantools.captureColors', JSON.stringify(recordedColors));
}
function sampleColorAt(event) {
  if (captureCanvas.hidden) return null;
  const rect = captureCanvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) * (captureCanvas.width / rect.width));
  const y = Math.floor((event.clientY - rect.top) * (captureCanvas.height / rect.height));
  if (x < 0 || y < 0 || x >= captureCanvas.width || y >= captureCanvas.height) return null;
  const pixel = captureCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
  return '#' + [pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function recordColor(hex) { if (!hex) return; recordedColors.unshift(hex); recordedColors = recordedColors.slice(0, 30); renderRecordedColors(); }
captureCanvas.addEventListener('mousemove', (event) => setLiveColor(sampleColorAt(event) || '#7DD3FC'));
captureCanvas.addEventListener('click', (event) => recordColor(sampleColorAt(event)));
$('clearColorsButton').addEventListener('click', () => { recordedColors = []; renderRecordedColors(); });
renderRecordedColors();
setLiveColor('#7DD3FC');
$('converterType').addEventListener('change', setupConverter); $('converterInput').addEventListener('input', updateConversion); $('converterFrom').addEventListener('change', updateConversion); $('converterTo').addEventListener('change', updateConversion);
$('addReminder').addEventListener('click', addReminder); $('generateQr').addEventListener('click', async () => { const text = $('qrText').value.trim(); if (!text) return toast('请输入要生成的内容'); $('qrOutput').innerHTML = `<img alt="二维码" src="${await window.desktopAPI.generateQr(text)}"><button class="utility-button" id="copyQr" type="button">复制内容</button>`; $('copyQr').addEventListener('click', () => window.desktopAPI.copyClipboard(text).then(() => toast('内容已复制'))); });
$('openSpeechFile').addEventListener('click', async () => { const file = await window.desktopAPI.openSpeechFile(); if (!file) return; $('speechFileName').textContent = file.name; $('speechText').value = file.text; $('speechCharCount').textContent = `${file.text.length.toLocaleString()} 字`; speechLoadVoices(); }); $('speechText').addEventListener('input', () => { $('speechCharCount').textContent = `${$('speechText').value.length.toLocaleString()} 字`; });
document.querySelectorAll('.value-copy').forEach((button) => button.addEventListener('click', () => window.desktopAPI.copyClipboard(button.querySelector('b').textContent).then(() => toast('颜色值已复制'))));
let speechVoices = [];
function speechLoadVoices() { speechVoices = window.speechSynthesis?.getVoices?.() || []; $('speechVoice').innerHTML = speechVoices.map((voice, index) => `<option value="${index}">${voice.name} (${voice.lang})</option>`).join(''); const preferred = speechVoices.findIndex((voice) => /^zh/i.test(voice.lang)); if (preferred >= 0) $('speechVoice').value = String(preferred); }
function speechSpeak() { const text = $('speechText').value.trim(); if (!text || !window.speechSynthesis) return toast('当前系统没有可用的语音引擎'); if (window.speechSynthesis.paused) { window.speechSynthesis.resume(); $('speechStatus').innerHTML = '<i></i>正在朗读'; return; } if (window.speechSynthesis.speaking) { window.speechSynthesis.pause(); $('speechStatus').innerHTML = '<i></i>已暂停'; return; } const utterance = new SpeechSynthesisUtterance(text); const voice = speechVoices[Number($('speechVoice').value)]; if (voice) utterance.voice = voice; utterance.rate = Number($('speechRate').value); utterance.pitch = Number($('speechPitch').value); utterance.onstart = () => { $('speechStatus').innerHTML = '<i></i>正在朗读'; $('speechPlay').textContent = 'Ⅱ 暂停'; }; utterance.onend = () => { $('speechStatus').innerHTML = '<i></i>朗读完成'; $('speechPlay').textContent = '▶ 开始朗读'; }; utterance.onerror = () => { $('speechStatus').innerHTML = '<i></i>朗读失败'; $('speechPlay').textContent = '▶ 开始朗读'; }; window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance); }
$('speechPlay').addEventListener('click', speechSpeak); $('speechStop').addEventListener('click', () => { window.speechSynthesis?.cancel(); $('speechStatus').innerHTML = '<i></i>准备朗读'; $('speechPlay').textContent = '▶ 开始朗读'; }); $('speechRate').addEventListener('input', (event) => { $('speechRateValue').textContent = `${Number(event.target.value).toFixed(1)}x`; }); $('speechPitch').addEventListener('input', (event) => { $('speechPitchValue').textContent = Number(event.target.value).toFixed(1); }); window.speechSynthesis?.addEventListener?.('voiceschanged', speechLoadVoices); speechLoadVoices();
$('pomodoroStart').addEventListener('click', () => { pomodoroRunning = !pomodoroRunning; pomodoroLastTick = 0; if (pomodoroRunning) pomodoroFrame = requestAnimationFrame(pomodoroTick); renderPomodoro(); }); $('pomodoroReset').addEventListener('click', () => { pomodoroRunning = false; pomodoroRemaining = 25 * 60000; renderPomodoro(); }); document.querySelectorAll('.pomodoro-preset').forEach((button) => button.addEventListener('click', () => { pomodoroRemaining = Number(button.dataset.min) * 60000; renderPomodoro(); }));
window.desktopAPI.onClipboardUpdated((history) => { clipboardItems = history; if (currentTool === 'clipboard') renderClipboard(); }); window.desktopAPI.getClipboard().then(({ enabled, history }) => { clipboardItems = history; $('clipboardEnabled').checked = enabled; });
window.desktopAPI.onNotesUpdated((updated) => { const index = notes.findIndex((note) => note.id === updated.id); if (index < 0) return; notes[index] = { ...notes[index], ...updated }; localStorage.setItem('zhuomiantools.notes', JSON.stringify(notes)); if (currentTool === 'notes') renderNotes(); });
window.desktopAPI.onWidgetCommand?.((command) => { if (command === 'toggle') setRunning(!state.running); }); window.desktopAPI.onWidgetRequestState?.(() => renderTimer()); window.desktopAPI.onReminderFired((id) => { const stored = JSON.parse(localStorage.getItem('zhuomiantools.reminders') || '[]'); localStorage.setItem('zhuomiantools.reminders', JSON.stringify(stored.filter((item) => item.id !== id))); if (currentTool === 'reminders') renderReminders(); });
window.desktopAPI.onShortcutTriggered((name) => { if (name === 'startTimer') setRunning(!state.running); else if (name === 'newNote') { selectTool('notes'); addNote(); } else if (name === 'openClipboard') selectTool('clipboard'); else if (name === 'screenshot') { selectTool('capture'); $('captureScreenButton').click(); } else if (name === 'colorPicker') selectTool('capture'); });

if (state.alwaysOnTop) window.desktopAPI.setAlwaysOnTop(true); if (state.opacity !== 100) window.desktopAPI.setOpacity(state.opacity / 100);
stopwatchMode.classList.toggle('active', state.mode === 'stopwatch'); countdownMode.classList.toggle('active', state.mode === 'countdown'); renderTimer(); renderPomodoro(); renderReminders(); selectTool('timer');
