/**
 * Your photo from the phone (contracts CT-265, docs/decisions/person-avatars.md PA-06): picked from the library with
 * the system's square crop (`allowsEditing`, 1:1), then its centre square scaled to `AVATAR_PIXELS` and saved as JPEG
 * by expo-image-manipulator, stepping quality and size down (`fitAvatar`) until it is at most `AVATAR_MAX_BYTES`; the
 * base64 is what `me.setAvatar` takes. Whatever the library had (HEIC, a huge photo) leaves as a small JPEG.
 */
import { AvatarImageError, avatarSquare, base64DecodedBytes, fitAvatar } from '@whombat/client';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

/** The square photo as base64 JPEG, or null when the person cancelled. */
export async function pickPhoto(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    exif: false,
    quality: 1,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return photoFromImage(asset.uri, asset.width, asset.height);
}

/** An image file as the photo: its centre square (the picker's crop may be a pixel off), scaled and encoded. */
export async function photoFromImage(uri: string, width: number, height: number): Promise<string> {
  const square = avatarSquare(width, height);
  return fitAvatar(async ({ side, quality }) => {
    const context = ImageManipulator.manipulate(uri)
      .crop({ originX: square.x, originY: square.y, width: square.side, height: square.side })
      .resize({ width: side, height: side });
    try {
      const image = await context.renderAsync();
      try {
        const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: true });
        if (!saved.base64) throw new AvatarImageError('unreadable');
        return { bytes: base64DecodedBytes(saved.base64), value: saved.base64 };
      } finally {
        image.release();
      }
    } finally {
      context.release();
    }
  });
}
