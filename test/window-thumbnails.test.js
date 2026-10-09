const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExternalWindowService } = require('../src/external-windows');
const { sourceHandle, findWindowSource, withWindowThumbnails } = require('../src/window-thumbnails');

function source(id, image, empty = false) {
  return { id, thumbnail: { isEmpty: () => empty, toDataURL: () => image } };
}

test('matches thumbnails by handle when windows have the same title', () => {
  const windows = [{ handle: '101', title: '文档' }, { handle: '202', title: '文档' }];
  const sources = [source('window:202:0', 'data:image/png;base64,second'), source('window:101:0', 'data:image/png;base64,first')];
  assert.equal(sourceHandle('window:101:0'), '101');
  assert.equal(sourceHandle('screen:101:0'), null);
  assert.equal(findWindowSource(sources, '101'), sources[1]);
  assert.deepEqual(withWindowThumbnails(windows, sources).map((item) => item.thumbnail), ['data:image/png;base64,first', 'data:image/png;base64,second']);
});

test('does not use empty or unrelated captures', () => {
  const sources = [source('window:101:0', '', true), source('window:999:0', 'other')];
  assert.equal(findWindowSource(sources, '101'), undefined);
  assert.equal(withWindowThumbnails([{ handle: '101' }], sources)[0].thumbnail, null);
});

test('Electron window captures match real Win32 handles', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const output = path.join(os.tmpdir(), `window-capture-${process.pid}-${Date.now()}.json`);
  const electron = require('electron');
  const child = spawn(electron, [path.join(__dirname, 'fixtures', 'inspect-capture-sources.js')], { env: { ...process.env, CAPTURE_OUTPUT: output }, windowsHide: true });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Electron 窗口捕获超时')); }, 20000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '捕获脚本未写入结果');
    const sources = JSON.parse(fs.readFileSync(output, 'utf8'));
    const windows = await createExternalWindowService().list();
    const handles = new Set(windows.map((window) => window.handle));
    assert.ok(sources.some((source) => handles.has(sourceHandle(source.id)) && source.image && source.size.width > 0), 'at least one captured window has a matching Win32 handle and image');
  } finally { child.kill(); if (fs.existsSync(output)) fs.unlinkSync(output); }
});
