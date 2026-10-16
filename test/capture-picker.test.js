const assert = require('node:assert/strict');
const { test } = require('node:test');
const { imageBounds, pointFromClient, placeLoupe } = require('../src/capture-picker');
const { capturePrimaryScreen } = require('../src/screen-capture');

test('pixel mapping preserves native coordinates under fractional scaling and letterboxing', () => {
  const rect = { left: 100, top: 50, width: 600, height: 400 };
  const bounds = imageBounds(rect, 2400, 1200);
  assert.deepEqual(bounds, { left: 100, top: 100, width: 600, height: 300, scale: .25 });
  assert.deepEqual(pointFromClient(rect, 2400, 1200, 100, 100), { x: 0, y: 0 });
  assert.deepEqual(pointFromClient(rect, 2400, 1200, 699.99, 399.99), { x: 2399, y: 1199 });
  assert.deepEqual(pointFromClient(rect, 2400, 1200, 351.375, 175.375), { x: 1005, y: 301 });
  for (const [x, y] of [[100, 99], [99, 100], [700, 100], [100, 400]]) assert.equal(pointFromClient(rect, 2400, 1200, x, y), null);
  assert.equal(pointFromClient({ left: 0, top: 0, width: 0, height: 0 }, 2400, 1200, 0, 0), null);
});

test('loupe flips near viewport edges and stays visible', () => {
  for (const [x, y] of [[0, 0], [639, 0], [0, 479], [639, 479], [320, 240]]) {
    const position = placeLoupe(x, y, 262, 350, 640, 480);
    assert.ok(position.left >= 8 && position.left + 262 <= 632);
    assert.ok(position.top >= 8 && position.top + 350 <= 472);
  }
  assert.deepEqual(placeLoupe(100, 100, 200, 200, 1000, 800), { left: 124, top: 124 });
});

test('screen capture requests physical pixels and matches the primary display by ID', async () => {
  let request;
  const screen = { getPrimaryDisplay: () => ({ id: 42, size: { width: 1536, height: 864 }, scaleFactor: 1.25 }) };
  const desktopCapturer = { getSources: async (options) => {
    request = options;
    return [
      { display_id: '7', thumbnail: { isEmpty: () => false, toDataURL: () => 'wrong-screen' } },
      { display_id: '42', thumbnail: { isEmpty: () => false, toDataURL: () => 'primary-screen' } }
    ];
  } };
  assert.equal(await capturePrimaryScreen(desktopCapturer, screen), 'primary-screen');
  assert.deepEqual(request, { types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
});

test('screen capture reports missing or empty primary screen instead of sampling another screen', async () => {
  const screen = { getPrimaryDisplay: () => ({ id: 42, size: { width: 1920, height: 1080 }, scaleFactor: 1 }) };
  for (const sources of [[], [{ display_id: '7' }], [{ display_id: '42', thumbnail: { isEmpty: () => true } }]]) {
    await assert.rejects(capturePrimaryScreen({ getSources: async () => sources }, screen), /无法获取主屏幕/);
  }
});

test('Windows with no display ID captures only an unambiguous single display', async () => {
  const display = { id: 42, size: { width: 1920, height: 1080 }, scaleFactor: 1 };
  const source = { display_id: '', thumbnail: { isEmpty: () => false, toDataURL: () => 'single-screen' } };
  const desktopCapturer = { getSources: async () => [source] };
  assert.equal(await capturePrimaryScreen(desktopCapturer, { getPrimaryDisplay: () => display, getAllDisplays: () => [display] }), 'single-screen');
  await assert.rejects(capturePrimaryScreen(desktopCapturer, { getPrimaryDisplay: () => display, getAllDisplays: () => [display, { id: 7 }] }), /无法获取主屏幕/);
});
