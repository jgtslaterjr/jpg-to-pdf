# JPG to Searchable PDF

A small web app that converts JPG (or PNG) photos of documents into searchable
PDFs. Background-lightening controls run live in the browser so you can flatten
yellowed paper or shadows without washing out the text, then the server runs
Tesseract OCR and stitches the result into a multi-page PDF with a per-word
invisible text layer that aligns with the words on the page.

## Features

- Drag-and-drop multi-image upload (JPG/PNG)
- Live preview with sliders:
  - **Background lighten** — pushes paper-tone pixels to white
  - **Text darken** — pushes near-black pixels to true black
  - Brightness, contrast, optional grayscale
- High-resolution export of the adjusted images to JPG
- OCR via Tesseract.js with **per-word bounding boxes** so search highlights
  and click-and-drag selection track the actual words in the image
- Searchable, multi-page PDF assembled with `pdf-lib` using PDF text rendering
  mode 3 (invisible-but-selectable glyphs)

## Setup

```bash
npm install
# optional — copy .env.example if you want to change OCR_LANG or PORT
cp .env.example .env
npm start
```

Open <http://localhost:3000>.

The first OCR run downloads the Tesseract language model (~10 MB) into
`.tessdata/` and reuses it on subsequent runs.

## Configuration

Environment variables (see `.env.example`):

| Variable    | Default | Description                                                                                  |
| ----------- | ------- | -------------------------------------------------------------------------------------------- |
| `OCR_LANG`  | `eng`   | Tesseract language(s). Examples: `eng`, `fra`, `deu`, `spa`, or combined like `eng+fra`.     |
| `PORT`      | `3000`  | HTTP port.                                                                                   |

## How it works

1. The browser draws each upload onto a `<canvas>` and applies your slider
   settings (levels-style black/white points, brightness, contrast, optional
   grayscale) per pixel.
2. On **Convert**, each adjusted page is re-rendered at up to 2400px wide,
   encoded as JPEG, and POSTed to `/api/convert`.
3. The server runs Tesseract on each image and gets a list of words with
   pixel-accurate bounding boxes.
4. It builds a PDF where each page is the adjusted image, then for every word
   draws an invisibly-rendered text glyph (rendering mode 3) at the matching
   pixel bbox. The selection rectangle and search highlight in any PDF viewer
   align with the word as it appears on the page.

## Notes

- Image upload limit is 25 MB per file, up to 50 files per request.
- The OCR text is sanitized to WinAnsi so it can be embedded with a built-in
  PDF font without external font assets.
- A single Tesseract worker is reused across requests; recognitions are
  serialized so the server stays stable under concurrent uploads.
