require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

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

const OCR_PROMPT = `You are an OCR engine. Transcribe ALL visible text from the document image as accurately as possible.

Rules:
- Preserve reading order (top-to-bottom, left-to-right; respect multi-column layouts).
- Preserve line breaks between visual lines.
- Use a single blank line between paragraphs or distinct blocks.
- Do not translate, summarize, or add commentary.
- Do not wrap output in code fences or quotes.
- If the page is blank or has no legible text, output exactly: [NO TEXT]
Return only the transcribed text.`;

async function transcribeImage(buffer, mimeType) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
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

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return text === '[NO TEXT]' ? '' : text;
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

    const cleanText = sanitizeForWinAnsi(page.text || '').trim();
    if (!cleanText) continue;

    // Render the OCR text as an invisible layer covering the page so the PDF
    // is searchable / selectable. Positions are not word-accurate, but the
    // text content is fully indexed.
    const lines = cleanText.split(/\r?\n/);
    const margin = Math.max(image.width, image.height) * 0.02;
    const usableWidth = image.width - margin * 2;
    const fontSize = 10;
    const lineHeight = fontSize * 1.2;

    const wrapped = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        wrapped.push('');
        continue;
      }
      const words = line.split(/\s+/);
      let current = '';
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        const width = font.widthOfTextAtSize(candidate, fontSize);
        if (width > usableWidth && current) {
          wrapped.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (current) wrapped.push(current);
    }

    const maxLines = Math.max(
      1,
      Math.floor((image.height - margin * 2) / lineHeight)
    );
    const visibleLines = wrapped.slice(0, maxLines);

    let y = image.height - margin - fontSize;
    for (const line of visibleLines) {
      if (line) {
        pdfPage.drawText(line, {
          x: margin,
          y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
          opacity: 0,
        });
      }
      y -= lineHeight;
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
      let text = '';
      try {
        text = await transcribeImage(file.buffer, mimeType);
      } catch (err) {
        console.error(`[ocr] failed for ${file.originalname}:`, err.message);
      }
      pages.push({ buffer: file.buffer, mimeType, text });
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
