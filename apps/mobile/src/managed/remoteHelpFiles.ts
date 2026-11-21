/**
 * A command line's file on the phone (app docs/decisions/remote-help.md AP-4477): Share writes a copy to the app's
 * cache for Android's share sheet (as DIAGNOSTICS shares its files, AP-1249), Download asks where with Android's “Save
 * as” (the backup file's, AP-1214) and writes the box's bytes there. The logic is `remoteHelp.ts`.
 */
import { File, FileMode, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { chooseSaveTarget } from './backupFileSave';
import type { TranscriptFiles } from './remoteHelp';

export const transcriptFiles: TranscriptFiles = {
  writeCache(name, bytes) {
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create();
    file.write(bytes);
    return file.uri;
  },
  removeCache(name) {
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
  },
  share: (uri, name) =>
    Sharing.shareAsync(uri, { mimeType: 'text/plain', UTI: 'public.plain-text', dialogTitle: name }),
  pickTarget: (name) => chooseSaveTarget(name),
  writeDocument(uri, bytes) {
    const handle = new File(uri).open(FileMode.Truncate);
    try {
      handle.writeBytes(bytes);
    } finally {
      handle.close();
    }
  },
  removeDocument(uri) {
    new File(uri).delete();
  },
};
