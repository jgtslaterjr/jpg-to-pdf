require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const {
  PDFDocument,
  StandardFonts,
  setTextRenderingMode,
  TextRenderingMode,
} = require('pdf-lib');

const app = express();
const port = process.env.PORT || 3000;
const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY is not set. OCR requests will fail until it is configured in .env');
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 },
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const OCR_PROMPT = `You are an OCR engine. Transcribe every visible line of text in this document image and report each line's position.

Output ONLY a JSON object. No markdown, no code fences, no commentary.

Schema:
{
  "lines": [
    { "text": "<exact text of this visual line>", "bbox": [x, y, w, h] }
  ]
}

Coordinates:
- bbox values are NORMALIZED in the range [0, 1].
- (x, y) is the TOP-LEFT corner of the line's bounding box.
- (0, 0) is the top-left of the image; (1, 1) is the bottom-right.
- w and h are the width and height of the line's bounding box.

Rules:
- Each entry is a single visual line of text (not a paragraph).
- Preserve reading order (top-to-bottom, left-to-right; respect multi-column layouts by reading column-by-column).
- Do not translate or summarize. Transcribe verbatim.
- If the page is blank or has no legible text, return: {"lines": []}`;

function parseOcrResponse(raw) {
  if (!raw) return { lines: [], fallbackText: '' };
  let text = raw.trim();
  // Strip ```json ... ``` fences if the model added them
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();

  // Try direct parse, then fall back to extracting first {...} block
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch (_) {}
    }
  }

  if (parsed && Array.isArray(parsed.lines)) {
    const lines = parsed.lines
      .map((line) => {
        const t = typeof line.text === 'string' ? line.text : '';
        const bb = Array.isArray(line.bbox) ? line.bbox.map(Number) : null;
        if (!t.trim() || !bb || bb.length !== 4 || bb.some((n) => !Number.isFinite(n))) return null;
        let [x, y, w, h] = bb;
        // If model returned percentages or pixel-ish numbers, normalize.
        const max = Math.max(x, y, x + w, y + h);
        if (max > 1.5) {
          const denom = max;
          x /= denom; y /= denom; w /= denom; h /= denom;
        }
        return {
          text: t,
          bbox: [
            Math.max(0, Math.min(1, x)),
            Math.max(0, Math.min(1, y)),
            Math.max(0, Math.min(1, w)),
            Math.max(0, Math.min(1, h)),
          ],
        };
      })
      .filter(Boolean);
    return { lines, fallbackText: '' };
  }

  // Couldn't parse JSON — keep raw text so we can still embed something searchable.
  return { lines: [], fallbackText: text };
}

async function transcribeImage(buffer, mimeType) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: buffer.toString('base64'),
            },
          },
          { type: 'text', text: OCR_PROMPT },
        ],
      },
    ],
  });

  const raw = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  return parseOcrResponse(raw);
}

function sanitizeForWinAnsi(text) {
  // pdf-lib's StandardFonts only support WinAnsi; strip characters outside it
  // so we can embed text invisibly without throwing.
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA1-\xFF]/g, '');
}

function drawInvisibleLineAtBBox(pdfPage, font, text, bbox, pageWidth, pageHeight) {
  const cleanText = sanitizeForWinAnsi(text).trim();
  if (!cleanText) return;

  const [nx, ny, nw, nh] = bbox;
  const boxX = nx * pageWidth;
  const boxYTop = ny * pageHeight; // distance from top in image coords
  const boxW = Math.max(1, nw * pageWidth);
  const boxH = Math.max(1, nh * pageHeight);

  // Pick a font size that fits the bbox. Use the smaller of (height-fit) and
  // (width-fit) so both selection-rect dimensions roughly match the painted text.
  let size = boxH * 0.95;
  const widthAtSize = font.widthOfTextAtSize(cleanText, size);
  if (widthAtSize > boxW) {
    size = size * (boxW / widthAtSize);
  }
  size = Math.max(2, size);

  // pdf-lib uses a bottom-left origin. Convert top-left bbox to PDF baseline.
  // Helvetica baseline sits ~80% of the cap height below the top.
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

  const rawLines = cleanText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (rawLines.length === 0) return;

  // Wrap to usableW at a provisional size, then pick a final size so all
  // wrapped lines fit usableH.
  const probeSize = 12;
  const wrapped = [];
  for (const line of rawLines) {
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

  const lineCount = Math.max(1, wrapped.length);
  const lineHeight = usableH / lineCount;
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
    const image = page.mimeType === 'image/png'
      ? await pdfDoc.embedPng(page.buffer)
      : await pdfDoc.embedJpg(page.buffer);

    const pdfPage = pdfDoc.addPage([image.width, image.height]);
    pdfPage.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });

    const ocr = page.ocr || { lines: [], fallbackText: '' };
    const hasLines = Array.isArray(ocr.lines) && ocr.lines.length > 0;
    const hasFallback = typeof ocr.fallbackText === 'string' && ocr.fallbackText.trim();

    if (!hasLines && !hasFallback) continue;

    // Text rendering mode 3 = invisible glyphs that are still indexed for
    // search and copy/paste.
    pdfPage.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));

    if (hasLines) {
      for (const line of ocr.lines) {
        drawInvisibleLineAtBBox(
          pdfPage,
          font,
          line.text,
          line.bbox,
          image.width,
          image.height
        );
      }
    } else {
      spreadFallbackTextAcrossPage(
        pdfPage,
        font,
        ocr.fallbackText,
        image.width,
        image.height
      );
    }
  }

  return pdfDoc.save();
}

app.post('/api/convert', upload.array('images', 50), async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded.' });
    }

    const pages = [];
    for (const file of req.files) {
      const mimeType = file.mimetype === 'image/png' ? 'image/png' : 'image/jpeg';
      let ocr = { lines: [], fallbackText: '' };
      try {
        ocr = await transcribeImage(file.buffer, mimeType);
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
  res.json({ ok: true, model, hasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.listen(port, () => {
  console.log(`jpg-to-pdf listening on http://localhost:${port}`);
});
