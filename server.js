require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const { createWorker } = require('tesseract.js');
const {
  PDFDocument,
  StandardFonts,
  setTextRenderingMode,
  TextRenderingMode,
} = require('pdf-lib');

const app = express();
const port = process.env.PORT || 3000;
const ocrLang = process.env.OCR_LANG || 'eng';
const tessDataDir = path.join(__dirname, '.tessdata');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 },
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- OCR (Tesseract.js) ---------------------------------------------------
// One worker is reused across requests. Tesseract workers are not safe to
// call concurrently, so recognitions are serialized through ocrQueue.

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    console.log(`[ocr] initializing Tesseract worker (lang=${ocrLang})…`);
    workerPromise = createWorker(ocrLang, 1, {
      cachePath: tessDataDir,
      logger: () => {},
    }).then((worker) => {
      console.log('[ocr] Tesseract ready');
      return worker;
    });
  }
  return workerPromise;
}

let ocrQueue = Promise.resolve();
function withWorker(fn) {
  const next = ocrQueue.then(fn);
  ocrQueue = next.catch(() => {});
  return next;
}

function collectWords(data) {
  // tesseract.js v5 exposes a tree under data.blocks. Some builds also expose
  // data.words at the top level; fall back to that if the tree is empty.
  const words = [];
  if (Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const w of line.words || []) {
            if (w && w.text && w.bbox) words.push(w);
          }
        }
      }
    }
  }
  if (words.length === 0 && Array.isArray(data.words)) {
    for (const w of data.words) {
      if (w && w.text && w.bbox) words.push(w);
    }
  }
  return words;
}

async function transcribeImage(buffer) {
  return withWorker(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer);
    const words = collectWords(data)
      .filter((w) => (w.confidence ?? 0) >= 30 && w.text.trim().length > 0)
      .map((w) => ({
        text: w.text,
        bbox: {
          x0: w.bbox.x0,
          y0: w.bbox.y0,
          x1: w.bbox.x1,
          y1: w.bbox.y1,
        },
        confidence: w.confidence ?? 0,
      }));
    return { words, fullText: data.text || '' };
  });
}

// --- PDF assembly ---------------------------------------------------------

function sanitizeForWinAnsi(text) {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA1-\xFF]/g, '');
}

function drawInvisibleWord(pdfPage, font, word, pageWidth, pageHeight) {
  const cleanText = sanitizeForWinAnsi(word.text).trim();
  if (!cleanText) return;

  const { x0, y0, x1, y1 } = word.bbox;
  const boxX = x0;
  const boxYTop = y0;
  const boxW = Math.max(1, x1 - x0);
  const boxH = Math.max(1, y1 - y0);

  // Match the painted text's bounding box to the word's pixel bbox so the
  // selection rectangle aligns with the glyphs in the underlying image.
  let size = boxH;
  const widthAtSize = font.widthOfTextAtSize(cleanText, size);
  if (widthAtSize > boxW && boxW > 0) {
    size = size * (boxW / widthAtSize);
  }
  size = Math.max(2, size);

  // pdf-lib uses a bottom-left origin; convert the top-left bbox accordingly.
  // Helvetica's baseline sits at roughly cap-height * 0.8 below the top.
  const x = boxX;
  const y = pageHeight - boxYTop - size * 0.8;

  pdfPage.drawText(cleanText, { x, y, size, font });
}

function spreadFallbackTextAcrossPage(pdfPage, font, fallbackText, pageWidth, pageHeight) {
  const cleanText = sanitizeForWinAnsi(fallbackText).trim();
  if (!cleanText) return;

  const margin = Math.min(pageWidth, pageHeight) * 0.04;
  const usableW = pageWidth - margin * 2;
  const usableH = pageHeight - margin * 2;

  const probeSize = 12;
  const wrapped = [];
  for (const rawLine of cleanText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    let cur = '';
    for (const word of words) {
      const cand = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(cand, probeSize) > usableW && cur) {
        wrapped.push(cur);
        cur = word;
      } else {
        cur = cand;
      }
    }
    if (cur) wrapped.push(cur);
  }
  if (wrapped.length === 0) return;

  const lineHeight = usableH / wrapped.length;
  const fontSize = Math.max(6, Math.min(lineHeight * 0.8, 36));

  let y = pageHeight - margin - fontSize;
  for (const line of wrapped) {
    let size = fontSize;
    const w = font.widthOfTextAtSize(line, size);
    if (w > usableW) size = size * (usableW / w);
    pdfPage.drawText(line, { x: margin, y, size, font });
    y -= lineHeight;
    if (y < margin) break;
  }
}

async function buildSearchablePdf(pages) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const page of pages) {
    const image =
      page.mimeType === 'image/png'
        ? await pdfDoc.embedPng(page.buffer)
        : await pdfDoc.embedJpg(page.buffer);

    const pdfPage = pdfDoc.addPage([image.width, image.height]);
    pdfPage.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });

    const ocr = page.ocr || { words: [], fullText: '' };
    const hasWords = Array.isArray(ocr.words) && ocr.words.length > 0;
    const hasFallback = typeof ocr.fullText === 'string' && ocr.fullText.trim();

    if (!hasWords && !hasFallback) continue;

    // Text rendering mode 3 = invisible glyphs that are still indexed for
    // search and copy/paste.
    pdfPage.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));

    if (hasWords) {
      for (const w of ocr.words) {
        drawInvisibleWord(pdfPage, font, w, image.width, image.height);
      }
    } else {
      spreadFallbackTextAcrossPage(pdfPage, font, ocr.fullText, image.width, image.height);
    }
  }

  return pdfDoc.save();
}

// --- HTTP routes ----------------------------------------------------------

app.post('/api/convert', upload.array('images', 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded.' });
    }

    const pages = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const mimeType = file.mimetype === 'image/png' ? 'image/png' : 'image/jpeg';
      let ocr = { words: [], fullText: '' };
      try {
        ocr = await transcribeImage(file.buffer);
      } catch (err) {
        console.error(`[ocr] failed for ${file.originalname}:`, err.message);
      }
      pages.push({ buffer: file.buffer, mimeType, ocr });
    }

    const pdfBytes = await buildSearchablePdf(pages);

    const firstName = (req.files[0].originalname || '').replace(/\.[^.]+$/, '');
    const requested = (req.body && req.body.filename) || firstName || 'document';
    const safeBase = requested.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim() || 'document';
    const outName = `${safeBase}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${outName}"; filename*=UTF-8''${encodeURIComponent(outName)}`
    );
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('[convert] error:', err);
    res.status(500).json({ error: err.message || 'Conversion failed.' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ocrLang });
});

app.listen(port, () => {
  console.log(`jpg-to-pdf listening on http://localhost:${port}`);
});
