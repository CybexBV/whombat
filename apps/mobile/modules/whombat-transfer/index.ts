/**
 * `whombat-transfer` — moving a big file to or from the phone (backup-file-android.md AP-1214, AP-1215): Android's
 * own “Save as” (`ACTION_CREATE_DOCUMENT`: Downloads and drives can be picked, the name is filled in), and keeping
 * the screen on while a transfer runs (`android/`, Kotlin; `ios/`, Swift, ios-parity.md AP-6323). The iPhone has no
 * “Save as” (`savesAs()` is false): saving picks a folder with expo-file-system there, as it does without the native
 * module (tests, a build from before it), where the screen also sleeps as usual.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface NativeWhombatTransfer {
  isSupported(): boolean;
  createDocument(name: string, mimeType: string): Promise<string | null>;
  keepScreenOn(on: boolean): boolean;
}

const native = requireOptionalNativeModule<NativeWhombatTransfer>('WhombatTransfer');

export const WhombatTransfer = {
  supported: (): boolean => {
    try {
      return native?.isSupported() ?? false;
    } catch {
      return false;
    }
  },
  /** Whether “Save as” is here (Android with the module). */
  savesAs: (): boolean => Platform.OS === 'android' && WhombatTransfer.supported(),
  /** Opens “Save as” with `name`; the new document's `content://` URI, or null when the person backed out. */
  async createDocument(name: string, mimeType: string): Promise<string | null> {
    if (!native) throw new Error('No “Save as” here.');
    return native.createDocument(name, mimeType);
  },
  /** Keeps the screen on while something moves (or lets it sleep again). */
  keepScreenOn(on: boolean): void {
    try {
      native?.keepScreenOn(on);
    } catch {
      // No activity right now: nothing to keep on.
    }
  },
};
