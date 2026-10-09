function sourceHandle(id) {
  const match = /^window:([1-9]\d*):\d+$/.exec(id);
  return match ? match[1] : null;
}

function findWindowSource(sources, handle) {
  return sources.find((source) => sourceHandle(source.id) === handle && !source.thumbnail.isEmpty());
}

function withWindowThumbnails(windows, sources) {
  const images = new Map();
  for (const source of sources) {
    const handle = sourceHandle(source.id);
    if (handle && !source.thumbnail.isEmpty()) images.set(handle, source.thumbnail.toDataURL());
  }
  return windows.map((window) => ({ ...window, thumbnail: images.get(window.handle) || null }));
}

module.exports = { sourceHandle, findWindowSource, withWindowThumbnails };
