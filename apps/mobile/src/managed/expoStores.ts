/** The native side of `stores.ts`: the registry file in the app's documents directory (expo-file-system). */
import { File, Paths } from 'expo-file-system';
import type { TextFile } from './stores';

export function documentTextFile(name: string): TextFile {
  const file = () => new File(Paths.document, name);
  return {
    read() {
      const f = file();
      return f.exists ? f.textSync() : null;
    },
    write(text) {
      const f = file();
      if (!f.exists) f.create({ overwrite: true });
      f.write(text);
    },
    remove() {
      const f = file();
      if (f.exists) f.delete();
    },
  };
}
