(() => {
  const fileInput = document.getElementById('fileInput');
  const dropzone = document.getElementById('dropzone');
  const thumbs = document.getElementById('thumbs');
  const pageCount = document.getElementById('pageCount');
  const convertBtn = document.getElementById('convertBtn');
  const resetBtn = document.getElementById('resetBtn');
  const statusEl = document.getElementById('status');
  const markRegionBtn = document.getElementById('markRegionBtn');
  const clearRegionsBtn = document.getElementById('clearRegionsBtn');

  const sliders = {
    whiteout: { el: document.getElementById('whiteout'), out: document.getElementById('whiteoutOut'), default: 55 },
    textBoost: { el: document.getElementById('textBoost'), out: document.getElementById('textBoostOut'), default: 25 },
    brightness: { el: document.getElementById('brightness'), out: document.getElementById('brightnessOut'), default: 10 },
    contrast: { el: document.getElementById('contrast'), out: document.getElementById('contrastOut'), default: 25 },
    feather: { el: document.getElementById('feather'), out: document.getElementById('featherOut'), default: 5 },
  };
  const grayscale = document.getElementById('grayscale');

  let regionMode = false;

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
    const featherPct = Number(sliders.feather.el.value);
    const isGray = grayscale.checked;

    const whitePoint = Math.max(80, 255 - whiteout);
    const blackPoint = Math.min(80, textBoost);
    const range = Math.max(1, whitePoint - blackPoint);
    const c = Math.max(-100, Math.min(100, contrast));
    const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));

    return { whitePoint, blackPoint, range, brightness, contrastFactor, isGray, featherPct };
  }

  function snapshotSliderState() {
    return {
      whiteout: Number(sliders.whiteout.el.value),
      textBoost: Number(sliders.textBoost.el.value),
      brightness: Number(sliders.brightness.el.value),
      contrast: Number(sliders.contrast.el.value),
      grayscale: grayscale.checked,
    };
  }

  function adjFromSliderState(s) {
    const whitePoint = Math.max(80, 255 - s.whiteout);
    const blackPoint = Math.min(80, s.textBoost);
    const range = Math.max(1, whitePoint - blackPoint);
    const c = Math.max(-100, Math.min(100, s.contrast));
    const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));
    return {
      whitePoint,
      blackPoint,
      range,
      brightness: s.brightness,
      contrastFactor,
      isGray: s.grayscale,
    };
  }

  function polygonBBox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // Rasterize the polygon into an alpha mask canvas at the same dimensions
  // as the target. Blurring the mask via ctx.filter gives us the feathered
  // edge in O(W*H) time regardless of how many points the user drew.
  function buildRegionMask(W, H, region, featherPct) {
    if (!region || !region.points || region.points.length < 3) return null;

    const mask = document.createElement('canvas');
    mask.width = W;
    mask.height = H;
    const ctx = mask.getContext('2d', { willReadFrequently: true });

    ctx.fillStyle = '#000';
    ctx.beginPath();
    const pts = region.points;
    ctx.moveTo(pts[0].x * W, pts[0].y * H);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * W, pts[i].y * H);
    }
    ctx.closePath();
    ctx.fill();

    const bbox = polygonBBox(pts);
    const minSidePx = Math.max(1, Math.min(bbox.w * W, bbox.h * H));
    const featherPx = Math.max(0, ((featherPct || 0) / 100) * minSidePx);
    if (featherPx <= 0.5) return mask;

    const blurred = document.createElement('canvas');
    blurred.width = W;
    blurred.height = H;
    const bctx = blurred.getContext('2d', { willReadFrequently: true });
    bctx.filter = `blur(${featherPx}px)`;
    bctx.drawImage(mask, 0, 0);
    return blurred;
  }

  // Apply current adjustments to all pixels. If a regionMask AND a baselineAdj
  // are provided, pixels outside the region use the baseline transform and
  // pixels inside use the current transform; the mask alpha drives a smooth
  // blend along the feathered edge so the rest of the document keeps the
  // look it had when the region was drawn.
  function applyAdjustments(canvas, currentAdj, baselineAdj, regionMask) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const W = canvas.width;
    const H = canvas.height;
    const img = ctx.getImageData(0, 0, W, H);
    const data = img.data;

    const useBlend = !!(regionMask && baselineAdj);
    const mask = useBlend
      ? regionMask
          .getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, W, H).data
      : null;

    const cBp = currentAdj.blackPoint;
    const cRange = currentAdj.range;
    const cBr = currentAdj.brightness;
    const cCf = currentAdj.contrastFactor;
    const cGr = currentAdj.isGray;

    const bAdj = baselineAdj || currentAdj;
    const bBp = bAdj.blackPoint;
    const bRange = bAdj.range;
    const bBr = bAdj.brightness;
    const bCf = bAdj.contrastFactor;
    const bGr = bAdj.isGray;

    for (let i = 0; i < data.length; i += 4) {
      const r0 = data[i];
      const g0 = data[i + 1];
      const b0 = data[i + 2];

      // Current (inside-the-region) transform.
      let rc = r0, gc = g0, bc = b0;
      if (cGr) {
        const lum = 0.299 * rc + 0.587 * gc + 0.114 * bc;
        rc = gc = bc = lum;
      }
      rc += cBr; gc += cBr; bc += cBr;
      rc = cCf * (rc - 128) + 128;
      gc = cCf * (gc - 128) + 128;
      bc = cCf * (bc - 128) + 128;
      rc = ((rc - cBp) / cRange) * 255;
      gc = ((gc - cBp) / cRange) * 255;
      bc = ((bc - cBp) / cRange) * 255;
      if (rc < 0) rc = 0; else if (rc > 255) rc = 255;
      if (gc < 0) gc = 0; else if (gc > 255) gc = 255;
      if (bc < 0) bc = 0; else if (bc > 255) bc = 255;

      if (!useBlend) {
        data[i] = rc;
        data[i + 1] = gc;
        data[i + 2] = bc;
        continue;
      }

      // Baseline (outside-the-region) transform.
      let rb = r0, gb = g0, bb = b0;
      if (bGr) {
        const lum = 0.299 * rb + 0.587 * gb + 0.114 * bb;
        rb = gb = bb = lum;
      }
      rb += bBr; gb += bBr; bb += bBr;
      rb = bCf * (rb - 128) + 128;
      gb = bCf * (gb - 128) + 128;
      bb = bCf * (bb - 128) + 128;
      rb = ((rb - bBp) / bRange) * 255;
      gb = ((gb - bBp) / bRange) * 255;
      bb = ((bb - bBp) / bRange) * 255;
      if (rb < 0) rb = 0; else if (rb > 255) rb = 255;
      if (gb < 0) gb = 0; else if (gb > 255) gb = 255;
      if (bb < 0) bb = 0; else if (bb > 255) bb = 255;

      const w = mask[i + 3] / 255;
      data[i]     = rb + (rc - rb) * w;
      data[i + 1] = gb + (gc - gb) * w;
      data[i + 2] = bb + (bc - bb) * w;
    }

    ctx.putImageData(img, 0, 0);
  }

  function renderPage(page) {
    const adj = getAdjustments();
    const previewCtx = page.previewCanvas.getContext('2d', { willReadFrequently: true });
    previewCtx.drawImage(page.sourceCanvas, 0, 0, page.previewCanvas.width, page.previewCanvas.height);
    const activeRegion = page.tempRegion || page.region;
    const baselineAdj = page.baselineSliders ? adjFromSliderState(page.baselineSliders) : null;
    // The mask is only needed once a baseline exists. While the user is
    // mid-drag (tempRegion set, no baseline yet), we render globally so the
    // outline previews on top of the image they already see.
    const mask = (page.region && baselineAdj)
      ? buildRegionMask(
          page.previewCanvas.width,
          page.previewCanvas.height,
          page.region,
          adj.featherPct
        )
      : null;
    applyAdjustments(page.previewCanvas, adj, baselineAdj, mask);
    drawRegionOutline(page.previewCanvas, activeRegion);
  }

  function drawRegionOutline(canvas, region) {
    if (!region || !region.points || region.points.length < 2) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const pts = region.points;
    const closed = region.points.length >= 3 && region.closed !== false;

    function tracePath() {
      ctx.beginPath();
      ctx.moveTo(pts[0].x * W, pts[0].y * H);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x * W, pts[i].y * H);
      }
      if (closed) ctx.closePath();
    }

    ctx.save();
    // White halo so the outline is visible on dark and light pages.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.setLineDash([]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    tracePath();
    ctx.stroke();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#c96442';
    ctx.setLineDash([6, 4]);
    tracePath();
    ctx.stroke();
    ctx.restore();
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
    attachRegionDrawing(page);

    const meta = document.createElement('div');
    meta.className = 'thumb-meta';
    const name = document.createElement('span');
    name.textContent = page.name;
    name.title = page.name;
    name.style.overflow = 'hidden';
    name.style.textOverflow = 'ellipsis';
    name.style.whiteSpace = 'nowrap';
    name.style.maxWidth = '60%';

    const right = document.createElement('span');
    right.style.display = 'flex';
    right.style.gap = '8px';

    const clearRegion = document.createElement('button');
    clearRegion.type = 'button';
    clearRegion.className = 'clear-region';
    clearRegion.textContent = 'Clear region';
    clearRegion.style.display = 'none';
    clearRegion.addEventListener('click', () => {
      page.region = null;
      page.tempRegion = null;
      page.baselineSliders = null;
      updateClearButton(page);
      renderPage(page);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removePage(page.id));

    right.appendChild(clearRegion);
    right.appendChild(remove);
    meta.appendChild(name);
    meta.appendChild(right);
    wrap.appendChild(meta);

    page._clearRegionBtn = clearRegion;

    thumbs.appendChild(wrap);
  }

  function updateClearButton(page) {
    if (!page._clearRegionBtn) return;
    page._clearRegionBtn.style.display = page.region ? 'inline' : 'none';
  }

  function attachRegionDrawing(page) {
    const canvas = page.previewCanvas;
    const MIN_POINT_DIST = 0.004; // ~0.4% of canvas — limits points per drag

    let drawing = null; // { points: [{x,y}, ...], pointerId, lastRender }
    let pendingFrame = null;

    function pointToNorm(e) {
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      return {
        x: Math.max(0, Math.min(1, nx)),
        y: Math.max(0, Math.min(1, ny)),
      };
    }

    function scheduleDrawingRender() {
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        renderPage(page);
      });
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (!regionMode) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const p = pointToNorm(e);
      drawing = { points: [p], pointerId: e.pointerId };
      page.tempRegion = { points: [p], closed: false };
      scheduleDrawingRender();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pointToNorm(e);
      const last = drawing.points[drawing.points.length - 1];
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if (dx * dx + dy * dy < MIN_POINT_DIST * MIN_POINT_DIST) return;
      drawing.points.push(p);
      page.tempRegion = { points: drawing.points.slice(), closed: false };
      scheduleDrawingRender();
    });

    function endDraw(e) {
      if (!drawing) return;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      const points = drawing.points.slice();
      drawing = null;
      page.tempRegion = null;

      // Need at least 3 distinct points to form an area; otherwise cancel.
      if (points.length < 3) {
        if (pendingFrame) {
          cancelAnimationFrame(pendingFrame);
          pendingFrame = null;
        }
        renderPage(page);
        return;
      }
      // Also ensure the polygon's bbox is non-trivial so a stray click
      // doesn't make a near-zero-area mask.
      const bbox = polygonBBox(points);
      if (bbox.w < 0.01 || bbox.h < 0.01) {
        renderPage(page);
        return;
      }

      page.region = { points };
      // Snapshot the slider values that produced the look the user already
      // sees. The polygon's interior will continue to follow the live
      // sliders from now on; the exterior is locked to this snapshot.
      if (!page.baselineSliders) {
        page.baselineSliders = snapshotSliderState();
      }
      updateClearButton(page);
      renderPage(page);
    }
    canvas.addEventListener('pointerup', endDraw);
    canvas.addEventListener('pointercancel', endDraw);
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

  function setRegionMode(on) {
    regionMode = Boolean(on);
    document.body.classList.toggle('region-mode', regionMode);
    markRegionBtn.classList.toggle('active', regionMode);
    markRegionBtn.textContent = regionMode ? 'Done marking' : 'Mark region';
  }

  markRegionBtn.addEventListener('click', () => setRegionMode(!regionMode));

  clearRegionsBtn.addEventListener('click', () => {
    for (const page of pages) {
      page.region = null;
      page.tempRegion = null;
      page.baselineSliders = null;
      updateClearButton(page);
    }
    renderAll();
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
      let exportCanvas = page.sourceCanvas;
      if (page.file && page.sourceCanvas.width < EXPORT_MAX_WIDTH) {
        try {
          const bitmap = await loadBitmap(page.file);
          if (bitmap.width > page.sourceCanvas.width) {
            exportCanvas = makeScaledCanvas(bitmap, EXPORT_MAX_WIDTH);
          }
        } catch (_) {}
      }

      const out = document.createElement('canvas');
      out.width = exportCanvas.width;
      out.height = exportCanvas.height;
      out.getContext('2d').drawImage(exportCanvas, 0, 0);
      // Region is normalized so it scales naturally to the export resolution.
      const baselineAdj = page.baselineSliders ? adjFromSliderState(page.baselineSliders) : null;
      const exportMask = (page.region && baselineAdj)
        ? buildRegionMask(out.width, out.height, page.region, adj.featherPct)
        : null;
      applyAdjustments(out, adj, baselineAdj, exportMask);

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

      const firstBase = (pages[0].name || '').replace(/\.[^.]+$/, '') || 'document';
      const outName = `${firstBase}.pdf`;
      formData.append('filename', firstBase);

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
      a.download = outName;
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
