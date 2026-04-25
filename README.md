# JPG to Searchable PDF

A small web app that converts JPG (or PNG) photos of documents into searchable
PDFs. Background-lightening controls run live in the browser so you can flatten
yellowed paper or shadows without washing out the text, then the server uses
the Anthropic API for OCR and stitches the result into a multi-page PDF with an
invisible text layer (selectable / searchable in any PDF viewer).

## Features

- Drag-and-drop multi-image upload (JPG/PNG)
- Live preview with sliders:
  - **Background lighten** — pushes paper-tone pixels to white
  - **Text darken** — pushes near-black pixels to true black
  - Brightness, contrast, optional grayscale
- High-resolution export of the adjusted images to JPG
- OCR via Claude vision (`claude-sonnet-4-6` by default)
- Searchable, multi-page PDF assembled with `pdf-lib`

## Setup

```bash
npm install
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY
npm start
```

Open <http://localhost:3000>.

## Configuration

Environment variables (see `.env.example`):

| Variable            | Default              | Description                          |
| ------------------- | -------------------- | ------------------------------------ |
| `ANTHROPIC_API_KEY` | _required_           | Your Anthropic API key.              |
| `ANTHROPIC_MODEL`   | `claude-sonnet-4-6`  | Vision-capable Claude model to use.  |
| `PORT`              | `3000`               | HTTP port.                           |

## How it works

1. The browser draws each upload onto a `<canvas>` and applies your slider
   settings (levels-style black/white points, brightness, contrast, optional
   grayscale) per pixel.
2. On **Convert**, each adjusted page is re-rendered at up to 2400px wide,
   encoded as JPEG, and POSTed to `/api/convert`.
3. The server sends every image to Claude with a strict OCR prompt, then builds
   a PDF where each page contains the adjusted image plus an invisible
   text layer with the transcription. The text isn't word-positioned, but
   PDF search and copy/paste work across the document.

## Notes

- Image upload limit is 25 MB per file, up to 50 files per request.
- The OCR text is sanitized down to WinAnsi so it can be embedded with a
  built-in PDF font without external font assets.
- If `ANTHROPIC_API_KEY` is missing, conversion returns a 500 with a clear
  error; the UI surfaces it.
