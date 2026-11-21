/**
 * `whombat-passkeys` — passkeys on Android through Credential Manager (passkeys.md AP-798) and on iPhone through
 * AuthenticationServices (ios-parity.md AP-6320): WebAuthn JSON in, WebAuthn JSON out (`android/`, Kotlin,
 * `androidx.credentials`; `ios/`, Swift). Without the native module (tests, an older build) `supported()` is false and
 * the app offers no passkeys.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface NativeWhombatPasskeys {
  isSupported(): boolean;
  /** `PublicKeyCredentialCreationOptionsJSON` → `RegistrationResponseJSON` (both as text). */
  create(requestJson: string): Promise<string>;
  /** `PublicKeyCredentialRequestOptionsJSON` → `AuthenticationResponseJSON`. */
  get(requestJson: string): Promise<string>;
  /**
   * WebAuthn's Signal API, passed to the passkey provider: `{rpId, credentialId}` (unknown) and `{rpId, userId,
   * allAcceptedCredentialIds}`. Resolve whether the provider took it; never reject. Missing in older builds.
   */
  forget?(requestJson: string): Promise<boolean>;
  keepOnly?(requestJson: string): Promise<boolean>;
  /**
   * Whether `get` passes WebAuthn's PRF extension on and answers `clientExtensionResults.prf.results.first` (Android:
   * the JSON goes to Credential Manager as it is; iPhone: iOS 18 and later). Missing in older builds.
   */
  supportsPrf?(): boolean;
}

const native = requireOptionalNativeModule<NativeWhombatPasskeys>('WhombatPasskeys');

/** Why a native call failed: the rejection's code (`cancelled`, `exists`, `none`, `unsupported`, `failed`). */
export function passkeyFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'failed';
}

export const WhombatPasskeys = {
  supported: (): boolean => {
    try {
      return native?.isSupported() ?? false;
    } catch {
      return false;
    }
  },
  async create(options: unknown): Promise<unknown> {
    if (!native) throw Object.assign(new Error('No passkeys here.'), { code: 'unsupported' });
    return JSON.parse(await native.create(JSON.stringify(options))) as unknown;
  },
  async get(options: unknown): Promise<unknown> {
    if (!native) throw Object.assign(new Error('No passkeys here.'), { code: 'unsupported' });
    return JSON.parse(await native.get(JSON.stringify(options))) as unknown;
  },
  /**
   * Whether a passkey prompt here can carry the PRF extension (backup-options-android.md AP-6855). An older build without
   * the function: Android's passes the JSON through anyway, an older iPhone build drops the extension.
   */
  prfSupported: (): boolean => {
    try {
      if (!native?.isSupported()) return false;
      return native.supportsPrf ? native.supportsPrf() : Platform.OS === 'android';
    } catch {
      return false;
    }
  },
  /** The provider stops offering this passkey; false where it couldn't be told (an older build or OS). */
  async forget(request: { rpId: string; credentialId: string }): Promise<boolean> {
    return (await native?.forget?.(JSON.stringify(request))) ?? false;
  },
  /** The provider hides `userId`'s passkeys that aren't listed. */
  async keepOnly(request: {
    rpId: string;
    userId: string;
    allAcceptedCredentialIds: string[];
  }): Promise<boolean> {
    return (await native?.keepOnly?.(JSON.stringify(request))) ?? false;
  },
};
