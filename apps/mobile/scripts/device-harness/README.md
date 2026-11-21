# On-device secure-session harness (AP-25)

Runs the real managed client stack on an Android device or emulator — endpoint key in expo-secure-store,
relay v1 dial over React Native's WebSocket, `@whombat/secure-channel` Noise XX pinned to the appliance PeerId,
session protocol v1, uploads read by offset through expo-file-system, downloads into cache files — against a
host-side relay stand-in with a real Noise responder serving the fake appliance.

```sh
export ANDROID_HOME=$HOME/Android/Sdk
pnpm --filter @whombat/mobile exec tsx scripts/device-harness/server.mts &     # :4799 (HARNESS_PORT)
EXPO_PUBLIC_ALLOW_INSECURE_HTTP=1 EXPO_PUBLIC_WHOMBAT_HARNESS_URL=http://localhost:4799 \
  pnpm --filter @whombat/mobile android:apk --variant release --clean
adb reverse tcp:4799 tcp:4799
adb install -r apps/mobile/build/whombat-release.apk && adb shell am start -n com.whombat.mobile/.MainActivity
```

The server prints one line per check and `HARNESS PASSED|FAILED`, then exits 0/1. Pass (secure-channel ADR
SC-05): every check ok, handshake p95 < 1 s, ≥ 1 MiB/s both ways. Rebuild without the two variables afterwards
(`--clean`): a harness build runs the harness instead of the app.
