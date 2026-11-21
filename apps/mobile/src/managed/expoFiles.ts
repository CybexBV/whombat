/** `FileApi` over expo-file-system 57 (native). */
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { FileApi, FileHandleLike } from './files';

export const expoFileApi: FileApi = {
  open(uri, mode) {
    const file = new File(uri);
    if (mode === 'w') {
      if (!file.exists) file.create({ overwrite: true });
      return file.open(FileMode.Truncate) as FileHandleLike;
    }
    return file.open(FileMode.ReadOnly) as FileHandleLike;
  },
  exists: (uri) => new File(uri).exists,
  mkdir(uri) {
    const d = new Directory(uri);
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
  },
  remove(uri) {
    for (const entry of [new File(uri), new Directory(uri)])
      try {
        if (entry.exists) entry.delete();
      } catch {
        // not that kind of entry
      }
  },
  async move(from, to) {
    const dest = new File(to);
    if (dest.exists) dest.delete();
    await new File(from).move(dest);
  },
  cacheDir: () => {
    const uri = Paths.cache.uri;
    return uri.endsWith('/') ? uri : `${uri}/`;
  },
};
