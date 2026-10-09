const time = document.getElementById('time');
const mode = document.getElementById('mode');
const status = document.getElementById('status');
const play = document.getElementById('play');
let snapshot = null;

function formatTime(totalMs) {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
  return [Math.floor(totalSeconds / 3600), Math.floor((totalSeconds % 3600) / 60), totalSeconds % 60]
    .map((part) => String(part).padStart(2, '0')).join(':');
}

function render() {
  if (!snapshot) return;
  const elapsed = snapshot.running ? Math.max(0, Date.now() - snapshot.startedAt) : 0;
  const value = snapshot.mode === 'stopwatch' ? snapshot.valueMs + elapsed : Math.max(0, snapshot.valueMs - elapsed);
  time.textContent = formatTime(value);
  time.style.color = snapshot.color;
  time.style.setProperty('--size', `${snapshot.fontSize}px`);
  mode.textContent = `计时器 · ${snapshot.mode === 'stopwatch' ? '秒表' : '倒计时'}`;
  status.textContent = snapshot.running ? '正在计时' : snapshot.mode === 'countdown' && value === 0 ? '时间到' : '准备就绪';
  play.textContent = snapshot.running ? 'Ⅱ' : '▶';
}

window.desktopAPI.onWidgetState((state) => { snapshot = state; render(); });
window.desktopAPI.widgetReady();
document.getElementById('play').addEventListener('click', () => window.desktopAPI.sendWidgetCommand('toggle'));
document.getElementById('close').addEventListener('click', () => window.desktopAPI.closeWidget());
setInterval(render, 200);
