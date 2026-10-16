async function capturePrimaryScreen(desktopCapturer, screen) {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor)
    }
  });
  let source = sources.find((item) => String(item.display_id) === String(display.id));
  // Windows can omit display_id (for example in remote display sessions).
  // A single source is unambiguous only when the OS also reports one display.
  if (!source && sources.length === 1 && !sources[0].display_id && screen.getAllDisplays().length === 1) source = sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取主屏幕截图，请重试');
  return source.thumbnail.toDataURL();
}

module.exports = { capturePrimaryScreen };
