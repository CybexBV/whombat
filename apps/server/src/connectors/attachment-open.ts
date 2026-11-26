/**
 * Opening a mail attachment to read it (`mail_attachment_open`): what the model can take in, made from the file's bytes
 * (never from the name or type the sender gave it). A PDF's text, read in a worker of its own (`pdf-read.ts`); a text
 * or HTML file's words; a PNG or JPEG as a picture beside the answer, made smaller when it is large. Anything else, and a
 * PDF without text (a scan), says in a few words why there is nothing to read.
 */
import {
  ATTACHMENT_TEXT_CAP,
  type ConnectorBinary,
  FEEDBACK_IMAGE_MAX_PIXELS,
  type OpenedAttachment,
} from '@whombat/core';
import type { ImageRunner } from '../feedback/image-pool';
import { sniffBuffer } from '../files/sniff';
import type { ToolImage } from '../mcp/image';
import { htmlToText } from './mime';
import { type PdfRead, readPdf } from './pdf-read';

/** A picture larger than this on its longest side is made smaller first: what a model reads at full detail. */
export const ATTACHMENT_PICTURE_EDGE = 1568;

export interface Opened {
  attachment: OpenedAttachment;
  /** The picture to send beside the answer. */
  picture: ToolImage | null;
}

export interface OpenDeps {
  images: ImageRunner;
  /** Tests read PDFs in-process. */
  readPdf?: (bytes: Uint8Array, maxChars: number) => Promise<PdfRead>;
}

const PDF_WHY: Record<Exclude<PdfRead, { ok: true }>['why'], string> = {
  password: 'This PDF is locked with a password.',
  broken: 'This PDF is damaged or can’t be read.',
  too_slow: 'This PDF took too long to read.',
};

/** The attachment as the model reads it. */
export async function openAttachment(file: ConnectorBinary, deps: OpenDeps): Promise<Opened> {
  const bytes = Buffer.from(file.contentBase64, 'base64');
  const base = { name: file.name, mimeType: file.mimeType, size: bytes.length };
  const none = (reason: string, pages?: number): Opened => ({
    attachment: {
      ...base,
      shows: 'none',
      text: null,
      truncated: false,
      ...(pages !== undefined ? { pages } : {}),
      reason,
    },
    picture: null,
  });
  const text = (words: string, more: { pages?: number; truncated?: boolean } = {}): Opened => {
    const cut = words.length > ATTACHMENT_TEXT_CAP;
    return {
      attachment: {
        ...base,
        shows: 'text',
        text: cut ? words.slice(0, ATTACHMENT_TEXT_CAP) : words,
        truncated: cut || more.truncated === true,
        ...(more.pages !== undefined ? { pages: more.pages } : {}),
      },
      picture: null,
    };
  };
  if (bytes.length === 0) return none('The attachment is empty.');
  const sniffed = sniffBuffer(bytes, file.name);
  if (!sniffed.ok) return none('This picture is damaged or too large to open.');
  const { contentType, kind, width, height } = sniffed.value;

  if (contentType === 'application/pdf') {
    const read = await (deps.readPdf ?? readPdf)(bytes, ATTACHMENT_TEXT_CAP);
    if (!read.ok) return none(PDF_WHY[read.why]);
    if (!read.text) return none('This PDF has no text in it: it is a scan or only pictures.', read.pages);
    return text(read.text, { pages: read.pages, truncated: read.truncated });
  }

  if (contentType === 'image/png' || contentType === 'image/jpeg') {
    if (!width || !height || width * height > FEEDBACK_IMAGE_MAX_PIXELS)
      return none('This picture is too large to open.');
    let picture: Buffer = bytes;
    if (Math.max(width, height) > ATTACHMENT_PICTURE_EDGE) {
      try {
        picture = (
          await deps.images.run({
            bytes,
            contentType,
            width,
            height,
            maxPixels: FEEDBACK_IMAGE_MAX_PIXELS,
            thumbnailMaxEdge: ATTACHMENT_PICTURE_EDGE,
          })
        ).bytes;
      } catch {
        return none('This picture is damaged or can’t be read.');
      }
    }
    return {
      attachment: { ...base, shows: 'picture', text: null, truncated: false },
      picture: { data: picture.toString('base64'), mimeType: contentType },
    };
  }

  if (kind === 'text') {
    const words = bytes.toString('utf8');
    const html =
      /html/i.test(file.mimeType) ||
      /\.x?html?$/i.test(file.name) ||
      /^\s*<(!doctype html|html)\b/i.test(words);
    return text(html ? htmlToText(words) : words.replace(/\r\n?/g, '\n'));
  }

  return none(`This kind of file (${contentType}) can’t be opened here.`);
}
