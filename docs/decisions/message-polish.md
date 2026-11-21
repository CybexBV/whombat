# Workstream: message polish

Small changes to how messages show, asked for by the maintainer after the rich-messages workstream
(`rich-messages.md`).

## Decisions

| # | Decision | Reason |
|---|---|---|
| MPO-01 | **Images in messages** (2026-09-27; contracts 0.12.2, CT-90; supersedes “no images” in RM-01). Asked for as: “When an agent replies with an image (for example an SVG) we see the code of the SVG, the SVG should actually be rendered. This applies to all images.” The shared parser gains an `image` inline for `![alt](src)` with `src` `https://…`, `http://…` or `data:image/(png\|jpeg\|gif\|webp\|svg+xml)` (anything else stays text), and gives an SVG document `lang: 'svg'` as a code block, whether written bare as a paragraph (`<svg …>…</svg>`, optional `<?xml?>` prolog) or fenced in `svg`, `xml`, `html` or no language. No new block type, so older clients show the code. Clients show an image **only through an image element** (`<img src>` with `svgImageSrc()`'s `data:` URI on web, an image or SVG view on mobile), never as inline DOM: an SVG as an image runs no script and loads nothing external. `data:` URIs are always allowed; http(s) images are subject to the client's CSP (the managed/hosted app may show them as a link). The persona tells agents to prefer a ```svg block, then `![alt](…)`, and to share PNG/JPEG/GIF/WebP/SVG files with `upload_file` + `attachmentIds`. `plainMessageText` reads an image as its alt text or `[image]`. Feedback's inert text escapes `[`, `(` and `>` and starts every line with a word joiner, so a report can't smuggle in an image (tested). | Agents draw charts and diagrams as SVG; showing the markup is useless, and rendering it as DOM would run the agent's (or an echoed visitor's) script in the app's origin. |
| MPO-02 | **SVG attachments are labelled, not served, as SVG.** The sniffer labels a UTF-8 `.svg` file that starts like an SVG document (optional BOM, prolog, comments, DOCTYPE, then `<svg`) `contentType: 'image/svg+xml'`, so a client can recognise it and show it as an image (fetch the text, `svgImageSrc`, `<img>`). Its kind stays `text` (BP-A03), so it is still a download: `servedContentType` sends a text file as its type only when that is one of the plain text types (`SERVED_TEXT_TYPES`: text/plain, text/markdown, application/json, text/csv, text/tab-separated-values, text/yaml), otherwise `text/plain; charset=utf-8`, with `Content-Disposition: attachment`, `nosniff` and `default-src 'none'; sandbox` as before (BP-A05). Both serving paths (`files/routes.ts`, managed `resources.ts`) use it. | The origin never serves markup a browser would render, while the metadata no longer hides what the file is. Clients branch on `kind`, not `contentType`, so nothing shows an SVG as a raster image by accident. |

## Verification

- Contracts: `markdown.test.ts` (images, unsafe sources, an image in a link, bare and fenced SVG, plain text) and
  `images.test.ts` (`isSafeImageSrc`, `svgImageSrc`, namespaces added, DOCTYPE with entities refused, size cap).
- Server: `files.test.ts` (SVG label, served as `text/plain`), `attachments.int.test.ts` (an uploaded SVG with a script
  is labelled `image/svg+xml`, kind `text`, and downloads as `text/plain`), `feedback/render.test.ts` (no image
  from a hostile report), persona snapshots.
