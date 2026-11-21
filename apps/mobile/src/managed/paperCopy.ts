/**
 * The paper copy on the phone (Whombat backup-passkey.md BPK-07; app backup-v2.md): only what opens the backups
 * (`paperCopyText`), printed through the share sheet (a print page a browser or printer app prints, as the kit's,
 * AP-6857) or saved as a file there; then the Whombat is told (`confirmPaperCopy`). The temporary file goes afterwards.
 */
import { BACKUP_OPTIONS_TEXT, confirmPaperCopy, kitQrPayload, paperCopyText } from '@whombat/client/managed';
import { type ApplianceSession, sessionOps } from '@whombat/client/session';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { kitPrintHtml } from './backupOptions';

export async function sharePaperCopy(input: {
  session: ApplianceSession;
  way: 'print' | 'file';
  /** The Whombat's name and identity, as the paper names them. */
  name: string;
  peerId: string;
  device: string;
}): Promise<void> {
  const P = BACKUP_OPTIONS_TEXT.paper;
  const material = await sessionOps.backupRecoveryMaterial(input.session);
  const text = paperCopyText({ applianceName: input.name, appliancePeerId: input.peerId, material });
  const print = input.way === 'print';
  const file = new File(Paths.cache, `whombat-backup-details-${input.device}.${print ? 'html' : 'txt'}`);
  if (file.exists) file.delete();
  file.create();
  file.write(
    print ? kitPrintHtml({ name: input.name, kitText: text, qrPayload: kitQrPayload(text), words: P }) : text,
  );
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: print ? 'text/html' : 'text/plain',
      dialogTitle: P.printTitle(input.name),
      UTI: print ? 'public.html' : 'public.plain-text',
    });
  } finally {
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
  await confirmPaperCopy(input.session, material);
}
