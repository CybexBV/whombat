/**
 * A picked file as the photo `me.setAvatar` takes (CT-265, docs/decisions/person-avatars.md PA-05): decoded by the
 * browser (any image it can draw, turned the way its EXIF says), its centre square scaled to `AVATAR_PIXELS` on a
 * canvas and encoded as JPEG, stepping quality and size down (`fitAvatar`) until it is at most `AVATAR_MAX_BYTES`;
 * then base64. Whatever was picked (an SVG, a 20 MB photo, a GIF) leaves as a small JPEG, or not at all.
 */
import { AvatarImageError, avatarSquare, base64, fitAvatar } from '@whombat/client';

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new AvatarImageError('unreadable');
  }
}

/** The photo's bytes as base64 (JPEG, an `AVATAR_PIXELS` square or smaller, at most `AVATAR_MAX_BYTES`). */
export async function photoFromFile(file: Blob): Promise<string> {
  const bitmap = await decode(file);
  try {
    const square = avatarSquare(bitmap.width, bitmap.height);
    const blob = await fitAvatar(async ({ side, quality }) => {
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      // JPEG has no transparency: a transparent picture sits on white, not black.
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, side, side);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, square.x, square.y, square.side, square.side, 0, 0, side, side);
      const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!out) throw new Error('encode');
      return { bytes: out.size, value: out };
    });
    return base64(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    bitmap.close();
  }
}
