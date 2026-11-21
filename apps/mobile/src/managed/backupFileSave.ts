/**
 * The backup file's native pieces (backup-file-android.md AP-1214…AP-1216): where a download is saved — Android's
 * “Save as” (`whombat-transfer`), else (the iPhone) expo-file-system's folder picker and a new file in it — written through an
 * expo-file-system handle on the document's `content://` URI; and the `.wbk` to restore, picked with
 * expo-document-picker without a cache copy (a file can be gigabytes) and read by offset as the upload asks for it.
 * The logic is in `backupFile.ts`.
 */
import type { BackupFileSink } from '@whombat/client';
import type { ChunkSource } from '@whombat/client/session';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode } from 'expo-file-system';
import { WhombatTransfer } from '../../modules/whombat-transfer';
import {
  documentSink,
  pickedBackupFile,
  pickSaveTarget,
  type SaveTargetApi,
  type WritableDocuments,
} from './backupFile';
import { expoFileApi } from './expoFiles';
import { fileChunkSource } from './files';

const backedOut = (error: unknown): boolean => {
  const e = error as { code?: unknown; message?: unknown } | null;
  return /cancel/i.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`);
};

const saveTargets = (): SaveTargetApi => ({
  saveAs: WhombatTransfer.savesAs()
    ? (name, mimeType) => WhombatTransfer.createDocument(name, mimeType)
    : null,
  async pickFolder() {
    try {
      return await Directory.pickDirectoryAsync();
    } catch (error) {
      if (backedOut(error)) return null;
      throw error;
    }
  },
});

const documents: WritableDocuments = {
  openWrite: (uri) => new File(uri).open(FileMode.Truncate),
  remove: (uri) => new File(uri).delete(),
};

/** Asks where to save `name` (“Save as”, else a folder): the new document's URI, null when the person backed out. */
export function chooseSaveTarget(name: string): Promise<string | null> {
  return pickSaveTarget(saveTargets(), name);
}

/** Asks where to save `name` and answers the sink that writes there; null when the person backed out. */
export async function chooseBackupSink(name: string): Promise<BackupFileSink | null> {
  const uri = await chooseSaveTarget(name);
  return uri ? documentSink(documents, uri) : null;
}

/**
 * Asks for the file to restore: its source (close it once the upload is over), why it can't be uploaded, or null when
 * the person backed out.
 */
export async function pickBackupSource(): Promise<
  { source: ChunkSource & { close(): void } } | { problem: string } | null
> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: false,
    multiple: false,
  });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const picked = pickedBackupFile(asset);
  return 'problem' in picked ? picked : { source: fileChunkSource(expoFileApi, picked.file) };
}

/** Keeps the screen on while a file moves (the phone sleeping would pause it). */
export const keepScreenOn = (on: boolean): void => WhombatTransfer.keepScreenOn(on);
