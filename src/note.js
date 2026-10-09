let note = null;
const text = document.getElementById('noteText');
const stateLabel = document.getElementById('noteState');

function render() {
  if (!note) return;
  text.value = note.text || '';
  document.documentElement.style.setProperty('--note', note.color || '#f9d77e');
}

window.desktopAPI.onNoteState((next) => { note = next; render(); });
text.addEventListener('input', () => {
  if (!note) return;
  note.text = text.value;
  stateLabel.textContent = '正在同步';
  window.desktopAPI.updateNoteWindow(note);
  window.clearTimeout(window.__noteSyncTimer);
  window.__noteSyncTimer = window.setTimeout(() => { stateLabel.textContent = '已同步'; }, 250);
});
document.getElementById('closeButton').addEventListener('click', () => { if (note) window.desktopAPI.closeNoteWindow(note.id); });
document.getElementById('pinButton').addEventListener('click', () => { stateLabel.textContent = '已置顶'; });
