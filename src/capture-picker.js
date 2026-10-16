(function (root) {
  const zoomLevels = [8, 12, 16];
  const cells = 15;

  // Account for both CSS scaling and any object-fit letterboxing.
  function imageBounds(rect, width, height) {
    const scale = Math.min(rect.width / width, rect.height / height);
    return { left: rect.left + (rect.width - width * scale) / 2, top: rect.top + (rect.height - height * scale) / 2, width: width * scale, height: height * scale, scale };
  }

  function pointFromClient(rect, width, height, clientX, clientY) {
    const bounds = imageBounds(rect, width, height);
    if (!(bounds.scale > 0)) return null;
    const x = Math.floor((clientX - bounds.left) / bounds.scale);
    const y = Math.floor((clientY - bounds.top) / bounds.scale);
    return x >= 0 && y >= 0 && x < width && y < height ? { x, y } : null;
  }

  function placeLoupe(x, y, width, height, viewportWidth, viewportHeight) {
    const gap = 24;
    return {
      left: Math.max(8, Math.min(x + gap + width <= viewportWidth - 8 ? x + gap : x - gap - width, viewportWidth - width - 8)),
      top: Math.max(8, Math.min(y + gap + height <= viewportHeight - 8 ? y + gap : y - gap - height, viewportHeight - height - 8))
    };
  }

  function initialize({ api, notify }) {
    const $ = (id) => document.getElementById(id);
    const canvas = $('captureCanvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const loupe = $('captureLoupe');
    const lens = $('captureLoupeCanvas');
    const target = $('captureTarget');
    const zoomControl = $('captureZoom');
    let point = null;
    let zoom = 12;
    let recorded = JSON.parse(localStorage.getItem('zhuomiantools.captureColors') || '[]');

    function setLiveColor(hex) {
      hex = hex.toUpperCase();
      $('liveColorPreview').style.background = hex;
      $('hexValue').textContent = hex;
      $('rgbValue').textContent = hex.match(/\w{2}/g).map((part) => parseInt(part, 16)).join(', ');
      $('colorPickerInput').value = hex;
    }

    function renderRecorded() {
      const list = $('recordedColors');
      list.replaceChildren();
      for (const hex of recorded) {
        const item = document.createElement('li'); item.className = 'recorded-color';
        const swatch = document.createElement('span'); swatch.className = 'recorded-swatch'; swatch.style.background = hex;
        const value = document.createElement('span'); value.className = 'recorded-hex'; value.textContent = hex;
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'recorded-copy'; copy.textContent = '复制';
        copy.addEventListener('click', () => api.copyClipboard(hex).then(() => notify('颜色值已复制')));
        item.append(swatch, value, copy); list.append(item);
      }
      if (!recorded.length) { const empty = document.createElement('li'); empty.className = 'recorded-empty'; empty.textContent = '暂无记录'; list.append(empty); }
      localStorage.setItem('zhuomiantools.captureColors', JSON.stringify(recorded));
    }

    function hide() { loupe.hidden = true; target.hidden = true; }

    function show(next) {
      if (!next || canvas.hidden || $('captureView').hidden) { hide(); return; }
      point = next;
      const { x, y } = point;
      const pixel = context.getImageData(x, y, 1, 1).data;
      const hex = '#' + [...pixel].slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
      setLiveColor(hex);
      $('captureLoupeHex').textContent = hex;
      $('captureLoupeRgb').textContent = `RGB ${pixel[0]}, ${pixel[1]}, ${pixel[2]}`;
      $('captureLoupePosition').textContent = `X ${x} · Y ${y} · ${zoom}×`;
      $('captureLoupeSwatch').style.background = hex;
      $('capturePosition').textContent = `X ${x} · Y ${y}（从 0 起）`;

      lens.width = lens.height = cells * zoom;
      const ctx = lens.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const half = Math.floor(cells / 2);
      for (let row = 0; row < cells; row++) for (let col = 0; col < cells; col++) {
        ctx.fillStyle = (row + col) % 2 ? '#273344' : '#1a2330';
        ctx.fillRect(col * zoom, row * zoom, zoom, zoom);
      }
      const sx = Math.max(0, x - half), sy = Math.max(0, y - half);
      const width = Math.min(canvas.width, x + half + 1) - sx;
      const height = Math.min(canvas.height, y + half + 1) - sy;
      ctx.drawImage(canvas, sx, sy, width, height, (sx - x + half) * zoom, (sy - y + half) * zoom, width * zoom, height * zoom);
      ctx.strokeStyle = 'rgba(128,128,128,.45)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= cells; i++) { const p = i * zoom + .5; ctx.moveTo(p, 0); ctx.lineTo(p, lens.height); ctx.moveTo(0, p); ctx.lineTo(lens.width, p); }
      ctx.stroke();
      // Black and white outlines remain visible on either bright or dark pixels.
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeRect(half * zoom - .5, half * zoom - .5, zoom + 1, zoom + 1);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(half * zoom - .5, half * zoom - .5, zoom + 1, zoom + 1);
      const bounds = imageBounds(canvas.getBoundingClientRect(), canvas.width, canvas.height);
      const clientX = bounds.left + (x + .5) * bounds.scale;
      const clientY = bounds.top + (y + .5) * bounds.scale;
      loupe.hidden = false; target.hidden = false;
      const placement = placeLoupe(clientX, clientY, loupe.offsetWidth, loupe.offsetHeight, innerWidth, innerHeight);
      loupe.style.left = `${placement.left}px`; loupe.style.top = `${placement.top}px`;
      target.style.left = `${clientX}px`; target.style.top = `${clientY}px`;
    }

    function fromEvent(event) {
      return canvas.hidden ? null : pointFromClient(canvas.getBoundingClientRect(), canvas.width, canvas.height, event.clientX, event.clientY);
    }
    function record() {
      if (!point || canvas.hidden) return;
      recorded.unshift($('hexValue').textContent); recorded = recorded.slice(0, 30); renderRecorded();
      $('captureStatus').textContent = `已记录 ${recorded[0]} · 共 ${recorded.length} 条`;
    }

    canvas.addEventListener('mousemove', (event) => show(fromEvent(event)));
    canvas.addEventListener('mouseleave', hide);
    canvas.addEventListener('click', (event) => {
      const next = fromEvent(event); if (!next) return;
      canvas.focus({ preventScroll: true }); show(next); record();
    });
    canvas.addEventListener('focus', () => show(point || { x: Math.floor(canvas.width / 2), y: Math.floor(canvas.height / 2) }));
    canvas.addEventListener('blur', hide);
    canvas.addEventListener('keydown', (event) => {
      if (canvas.hidden) return;
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (moves[event.key]) {
        event.preventDefault();
        const [dx, dy] = moves[event.key];
        const current = point || { x: Math.floor(canvas.width / 2), y: Math.floor(canvas.height / 2) };
        show({ x: Math.max(0, Math.min(canvas.width - 1, current.x + dx)), y: Math.max(0, Math.min(canvas.height - 1, current.y + dy)) });
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(point); if (!event.repeat) record(); }
      else if (event.key === 'Escape') { event.preventDefault(); canvas.blur(); hide(); }
    });
    canvas.addEventListener('wheel', (event) => {
      if (event.ctrlKey || !event.deltaY || !fromEvent(event)) return;
      event.preventDefault();
      zoom = zoomLevels[Math.max(0, Math.min(zoomLevels.length - 1, zoomLevels.indexOf(zoom) + (event.deltaY < 0 ? 1 : -1)))];
      zoomControl.value = String(zoom); show(fromEvent(event));
    }, { passive: false });
    zoomControl.addEventListener('change', () => { zoom = Number(zoomControl.value); hide(); });
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    document.addEventListener('scroll', hide, true);
    new MutationObserver(hide).observe($('captureView'), { attributes: true, attributeFilter: ['hidden'] });
    $('colorPickerInput').addEventListener('input', (event) => { hide(); setLiveColor(event.target.value); });
    $('clearColorsButton').addEventListener('click', () => { recorded = []; renderRecorded(); $('captureStatus').textContent = '颜色记录已清空'; });

    $('captureScreenButton').addEventListener('click', async () => {
      const button = $('captureScreenButton');
      if (button.disabled) return;
      hide(); button.disabled = true; button.textContent = '正在截图…';
      try {
        const dataUrl = await api.captureScreen();
        if (!dataUrl) throw new Error('没有获取到屏幕图像');
        const image = new Image(); image.src = dataUrl; await image.decode();
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        context.drawImage(image, 0, 0); canvas.hidden = false; point = null;
        $('capturePreview').querySelector('.empty-state').classList.add('hidden');
        $('capturePosition').textContent = `${canvas.width} × ${canvas.height} 像素`;
        $('captureStatus').textContent = '截图已更新，悬浮查看像素，点击记录颜色';
      } catch (error) { $('captureStatus').textContent = `截图失败：${error.message}，请重试`; notify(`截图失败：${error.message}`); }
      finally { button.disabled = false; button.textContent = '⌗ 截取当前屏幕'; }
    });
    renderRecorded(); setLiveColor('#7DD3FC');
  }

  const picker = { imageBounds, pointFromClient, placeLoupe, initialize };
  if (typeof module !== 'undefined' && module.exports) module.exports = picker;
  else root.CapturePicker = picker;
})(typeof window !== 'undefined' ? window : globalThis);
