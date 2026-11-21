/**
 * Copy (MX-04): text to the system clipboard through expo-clipboard. Android 13 and later show their own “Copied”
 * preview, so the app's toast only shows on older phones (and other platforms), as Android's guidance asks.
 */
import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';
import { showFailure, showNotice } from '../screens/feedback';

/** Copies `text`; `copied` is said where the system doesn't say it itself. False when the copy failed. */
export async function copyToClipboard(text: string, copied: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
  } catch {
    showFailure('Couldn’t copy that.');
    return false;
  }
  const systemSaysSo = Platform.OS === 'android' && Number(Platform.Version) >= 33;
  if (!systemSaysSo) showNotice(copied);
  return true;
}
