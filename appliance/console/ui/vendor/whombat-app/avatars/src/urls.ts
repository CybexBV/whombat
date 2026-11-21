/**
 * The avatar files' URLs for the web (FA-06). Vite turns each `new URL('../svg/…', import.meta.url)` into a hashed asset
 * (`/assets/lead-bust-1a2b3c4d.svg`) served immutable, so a changed drawing gets a new URL (the brief's `?v=2`). The
 * files are ~20 KB, past Vite's 4 KB inline limit: each avatar is one cached request, never a data URI. The literal
 * paths must stay literal for Vite to see them.
 */
import { type AvatarCrop, type AvatarFace, type AvatarVariant, avatarVariant } from './index';

/** Each face's three files, by face (the files keep their drawing's stem, `AVATAR_FILE_STEMS`). */
export const AVATAR_URLS: Record<AvatarFace, Record<AvatarVariant, string>> = {
  dusty: {
    bust: new URL('../svg/associate-bust.svg', import.meta.url).href,
    head: new URL('../svg/associate-head.svg', import.meta.url).href,
    'head-small': new URL('../svg/associate-head-small.svg', import.meta.url).href,
  },
  banjo: {
    bust: new URL('../svg/developer-bust.svg', import.meta.url).href,
    head: new URL('../svg/developer-head.svg', import.meta.url).href,
    'head-small': new URL('../svg/developer-head-small.svg', import.meta.url).href,
  },
  neo: {
    bust: new URL('../svg/operator-bust.svg', import.meta.url).href,
    head: new URL('../svg/operator-head.svg', import.meta.url).href,
    'head-small': new URL('../svg/operator-head-small.svg', import.meta.url).href,
  },
  skipper: {
    bust: new URL('../svg/lead-bust.svg', import.meta.url).href,
    head: new URL('../svg/lead-head.svg', import.meta.url).href,
    'head-small': new URL('../svg/lead-head-small.svg', import.meta.url).href,
  },
  hazel: {
    bust: new URL('../svg/assistant-bust.svg', import.meta.url).href,
    head: new URL('../svg/assistant-head.svg', import.meta.url).href,
    'head-small': new URL('../svg/assistant-head-small.svg', import.meta.url).href,
  },
};

/** The URL of the file a face shows at `size` (FA-07). */
export function avatarUrl(face: AvatarFace, size: number, crop: AvatarCrop = 'auto'): string {
  return AVATAR_URLS[face][avatarVariant(size, crop)];
}
