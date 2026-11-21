/**
 * The client's integer build number (CT-53): what `hello.client.buildNumber` carries and the appliance compares with
 * the running release's client security floor. Android: `versionCode`; the hosted web UI: its build number
 * (`VITE_WHOMBAT_BUILD_NUMBER`, set by the build). Both come from the release version (`buildNumberOfVersion`, AP-259),
 * so a tag always builds the same number. Absent or not a valid build number: undefined (counts as 0 on the
 * appliance, so a floor refuses it).
 */

/** `ClientBuildNumber` of `@whombat/release`: an integer 0…2^31−1. */
const MAX_BUILD = 2 ** 31 - 1;

export function clientBuildNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_BUILD ? n : undefined;
}

/**
 * The build number of a release version (AP-259): `major × 1 000 000 + minor × 1 000 + patch`, so `0.12.0` is 12000
 * and `1.2.3` is 1002003. It only grows with the version, is the same for every build of a tag (web and Android
 * alike), and is above every commit-count number the hosted web used before (743 at 0.11.1). Minor and patch stay
 * below 1000. A version that isn't `X.Y.Z` (a pre-release suffix is ignored) has none: 0.
 */
export function buildNumberOfVersion(version: string): number {
  const m = /^(\d{1,4})\.(\d{1,3})\.(\d{1,3})(?:[-+].*)?$/.exec(version.trim());
  if (!m) return 0;
  const n = Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
  return n <= MAX_BUILD ? n : 0;
}
