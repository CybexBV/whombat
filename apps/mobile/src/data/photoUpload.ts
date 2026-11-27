/**
 * A picked or taken photo as it goes up (AP-908): a camera photo longer than 2048px on its longest side is scaled to
 * 2048 and saved as JPEG at 0.8 by expo-image-manipulator (`scalesDown`, `photoResize`), which also leaves its EXIF
 * (location included) behind; anything else, and any photo the phone can't scale, goes as picked.
 */
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  fromImageAsset,
  oneAtATime,
  PHOTO_JPEG_QUALITY,
  type PickedFile,
  photoResize,
  scaledPhoto,
  scalesDown,
} from './attachments';

type PickerAsset = Parameters<typeof fromImageAsset>[0] & { width?: number; height?: number };

export async function preparePhoto(
  asset: PickerAsset,
  index: number,
  now: Date,
  locale?: string,
): Promise<PickedFile | null> {
  const file = fromImageAsset(asset, index, now, locale);
  if (!file || !scalesDown(asset)) return file;
  const held: { release(): void }[] = [];
  const hold = <T extends { release(): void }>(ref: T): T => {
    held.push(ref);
    return ref;
  };
  try {
    // Decoded upright first (EXIF orientation applied), so the longest side is the one scaled.
    const image = await hold(ImageManipulator.manipulate(file.uri)).renderAsync();
    hold(image);
    const resize = hold(ImageManipulator.manipulate(image).resize(photoResize(image.width, image.height)));
    const scaled = hold(await resize.renderAsync());
    const saved = await scaled.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_JPEG_QUALITY });
    return scaledPhoto(file, { uri: saved.uri, size: new File(saved.uri).size });
  } catch {
    return file;
  } finally {
    for (const ref of held.reverse()) ref.release();
  }
}

/** A pick's photos as they go up, in the pick's order; one is prepared at a time (`oneAtATime`). */
export async function preparePhotos(
  assets: readonly PickerAsset[],
  now: Date,
  locale?: string,
): Promise<PickedFile[]> {
  const files = await oneAtATime(assets, (asset, index) => preparePhoto(asset, index, now, locale));
  return files.filter((f): f is PickedFile => f !== null);
}
