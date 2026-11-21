# whombat-passkeys

Passkeys on Android through Credential Manager (`androidx.credentials` 1.5.0 with Play services) and on iPhone through
AuthenticationServices, for the managed app's “Sign in with a passkey”, Set up this device and Devices → Passkeys
(docs/decisions/passkeys.md AP-798, docs/app/decisions/ios-parity.md AP-6320).

- `create(options)` / `get(options)`: WebAuthn JSON in and out; the app's `PasskeyPlatform` is
  `src/managed/passkeys.ts`.
- The origin Credential Manager reports is `android:apk-key-hash:<SHA-256 of the signing certificate, base64url>`;
  the Whombat and control accept the release key's (`PASSKEY_ANDROID_ORIGINS`). A debug-signed APK has another hash:
  its passkeys don't verify unless the Whombat lists it in `WHOMBAT_PASSKEY_EXTRA_ORIGINS`.
- The RP ID is the hosted UI's host; `apps/web/public/.well-known/assetlinks.json` grants this app
  `delegate_permission/common.get_login_creds` there, so Android lets it use that RP's passkeys.
- On iPhone the origin is `https://<RP ID>`, the hosted UI's own, which the Whombat and control accept as the web's.
  The app's `webcredentials:<host>` entitlement (app.config.cjs) and the `webcredentials` part of
  `apps/web/public/.well-known/apple-app-site-association` tie the app to that RP. A passkey on another device signs in
  through the QR code iOS offers. iOS has no “none on this phone” answer: a dismissed sheet is `cancelled`.
- WebAuthn's PRF extension (the recovery kit locked with a passkey, docs/app/decisions/backup-options-android.md
  AP-6855): `get` with `extensions.prf.eval.first` answers `clientExtensionResults.prf.results.first` (base64url) when
  the passkey offers it. Android passes the JSON to Credential Manager as it is; iPhone sets the assertion request's
  `prf` and reads the assertion's on iOS 18 and later. `supportsPrf()` says whether a prompt here can carry it.
