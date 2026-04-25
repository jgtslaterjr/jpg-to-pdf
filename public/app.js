(() => {
  const fileInput = document.getElementById('fileInput');
  const dropzone = document.getElementById('dropzone');
  const thumbs = document.getElementById('thumbs');
  const pageCount = document.getElementById('pageCount');
  const convertBtn = document.getElementById('convertBtn');
  const resetBtn = document.getElementById('resetBtn');
  const statusEl = document.getElementById('status');

  const sliders = {
    whiteout: { el: document.getElementById('whiteout'), out: document.getElementById('whiteoutOut'), default: 55 },
    textBoost: { el: document.getElementById('textBoost'), out: document.getElementById('textBoostOut'), default: 25 },
    brightness: { el: document.getElementById('brightness'), out: document.getElementById('brightnessOut'), default: 10 },
    contrast: { el: document.getElementById('contrast'), out: document.getElementById('contrastOut'), default: 25 },
  };
  const grayscale = document.getElementById('grayscale');

  const PREVIEW_MAX_WIDTH = 1100;
  const EXPORT_MAX_WIDTH = 2400;
  const EXPORT_QUALITY = 0.9;

  const pages = []; // { id, file, sourceBitmap, previewCanvas, exportCanvas, name }
  let nextId = 1;
  let renderTimer = null;

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function refreshPageCount() {
    if (pages.length === 0) {
      pageCount.textContent = 'No images loaded';
      convertBtn.disabled = true;
    } else {
      pageCount.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'} loaded`;
      convertBtn.disabled = false;
    }
  }

  async function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file);
      } catch (_) {
        // fall through to img element fallback
      }
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function makeScaledCanvas(bitmap, maxWidth) {
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    const scale = Math.min(1, maxWidth / srcW);
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas;
  }

  function getAdjustments() {
    const whiteout = Number(sliders.whiteout.el.value);
    const textBoost = Number(sliders.textBoost.el.value);
    const brightness = Number(sliders.brightness.el.value);
    const contrast = Number(sliders.contrast.el.value);
    const isGray = grayscale.checked;

    // Map whiteout 0..100 -> white point 255..155 (anything brighter becomes white)
    const whitePoint = Math.max(80, 255 - whiteout);
    // Map textBoost 0..100 -> black point 0..80 (anything darker becomes black)
    const blackPoint = Math.min(80, textBoost);
    const range = Math.max(1, whitePoint - blackPoint);
    // Standard contrast factor
    const c = Math.max(-100, Math.min(100, contrast));
    const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));

    return { whitePoint, blackPoint, range, brightness, contrastFactor, isGray };
  }

  function applyAdjustments(canvas, adj) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = img.data;
    const { whitePoint, blackPoint, range, brightness, contrastFactor, isGray } = adj;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      if (isGray) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = g = b = lum;
      }

      // Brightness (additive)
      r += brightness;
      g += brightness;
      b += brightness;

      // Contrast around mid-gray
      r = contrastFactor * (r - 128) + 128;
      g = contrastFactor * (g - 128) + 128;
      b = contrastFactor * (b - 128) + 128;

      // Levels: black -> 0, white -> 255
      r = ((r - blackPoint) / range) * 255;
      g = ((g - blackPoint) / range) * 255;
      b = ((b - blackPoint) / range) * 255;

      data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }

    ctx.putImageData(img, 0, 0);
  }

  function renderPage(page) {
    const adj = getAdjustments();

    // preview is rendered from the source each time
    const previewCtx = page.previewCanvas.getContext('2d', { willReadFrequently: true });
    previewCtx.drawImage(page.sourceCanvas, 0, 0, page.previewCanvas.width, page.previewCanvas.height);
    applyAdjustments(page.previewCanvas, adj);
  }

  function renderAll() {
    for (const page of pages) renderPage(page);
  }

  function scheduleRender() {
    if (renderTimer) cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(renderAll);
  }

  function buildThumb(page) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    wrap.dataset.id = String(page.id);

    page.previewCanvas = document.createElement('canvas');
    page.previewCanvas.width = page.sourceCanvas.width;
    page.previewCanvas.height = page.sourceCanvas.height;
    wrap.appendChild(page.previewCanvas);

    const meta = document.createElement('div');
    meta.className = 'thumb-meta';
    const name = document.createElement('span');
    name.textContent = page.name;
    name.title = page.name;
    name.style.overflow = 'hidden';
    name.style.textOverflow = 'ellipsis';
    name.style.whiteSpace = 'nowrap';
    name.style.maxWidth = '70%';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removePage(page.id));
    meta.appendChild(name);
    meta.appendChild(remove);
    wrap.appendChild(meta);

    thumbs.appendChild(wrap);
  }

  function removePage(id) {
    const idx = pages.findIndex((p) => p.id === id);
    if (idx === -1) return;
    pages.splice(idx, 1);
    const node = thumbs.querySelector(`.thumb[data-id="${id}"]`);
    if (node) node.remove();
    refreshPageCount();
  }

  async function addFiles(fileList) {
    const accepted = Array.from(fileList).filter((f) =>
      /^image\/(jpeg|jpg|png)$/i.test(f.type) || /\.(jpe?g|png)$/i.test(f.name)
    );
    if (accepted.length === 0) {
      setStatus('No JPG or PNG files in selection.', true);
      return;
    }

    setStatus(`Loading ${accepted.length} image${accepted.length === 1 ? '' : 's'}…`);
    for (const file of accepted) {
      try {
        const bitmap = await loadBitmap(file);
        const sourceCanvas = makeScaledCanvas(bitmap, PREVIEW_MAX_WIDTH);
        const page = {
          id: nextId++,
          file,
          name: file.name,
          sourceCanvas,
        };
        pages.push(page);
        buildThumb(page);
        renderPage(page);
      } catch (err) {
        console.error('failed to load', file.name, err);
      }
    }
    refreshPageCount();
    setStatus('');
  }

  function bindSlider(key) {
    const { el, out } = sliders[key];
    out.textContent = el.value;
    el.addEventListener('input', () => {
      out.textContent = el.value;
      scheduleRender();
    });
  }

  Object.keys(sliders).forEach(bindSlider);
  grayscale.addEventListener('change', scheduleRender);

  resetBtn.addEventListener('click', () => {
    for (const key of Object.keys(sliders)) {
      sliders[key].el.value = String(sliders[key].default);
      sliders[key].out.textContent = String(sliders[key].default);
    }
    grayscale.checked = true;
    scheduleRender();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });

  function exportPageBlob(page, adj) {
    return new Promise(async (resolve, reject) => {
      // Re-render at higher resolution from the source bitmap if larger.
      let exportCanvas = page.sourceCanvas;
      if (page.file && page.sourceCanvas.width < EXPORT_MAX_WIDTH) {
        try {
          const bitmap = await loadBitmap(page.file);
          if (bitmap.width > page.sourceCanvas.width) {
            exportCanvas = makeScaledCanvas(bitmap, EXPORT_MAX_WIDTH);
          }
        } catch (_) {
          // fallback to preview-size source
        }
      }

      // Apply adjustments to a copy so we don't mutate source.
      const out = document.createElement('canvas');
      out.width = exportCanvas.width;
      out.height = exportCanvas.height;
      out.getContext('2d').drawImage(exportCanvas, 0, 0);
      applyAdjustments(out, adj);

      out.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
        'image/jpeg',
        EXPORT_QUALITY
      );
    });
  }

  convertBtn.addEventListener('click', async () => {
    if (pages.length === 0) return;
    convertBtn.disabled = true;
    resetBtn.disabled = true;
    setStatus(`Preparing ${pages.length} page${pages.length === 1 ? '' : 's'}…`);

    try {
      const adj = getAdjustments();
      const formData = new FormData();
      for (let i = 0; i < pages.length; i++) {
        setStatus(`Encoding page ${i + 1} of ${pages.length}…`);
        const blob = await exportPageBlob(pages[i], adj);
        const safe = pages[i].name.replace(/\.[^.]+$/, '') || `page-${i + 1}`;
        formData.append('images', blob, `${safe}.jpg`);
      }

      setStatus('Running OCR and building PDF… this can take a moment.');
      const res = await fetch('/api/convert', { method: 'POST', body: formData });
      if (!res.ok) {
        let msg = `Server error ${res.status}`;
        try {
          const err = await res.json();
          if (err && err.error) msg = err.error;
        } catch (_) {}
        throw new Error(msg);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'document.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('Done. Your searchable PDF has been downloaded.');
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Conversion failed.', true);
    } finally {
      convertBtn.disabled = pages.length === 0;
      resetBtn.disabled = false;
    }
  });

  refreshPageCount();
})();
