/**
 * The pinned Hermes release (HE-28): what `pnpm hermes:install` installs and the runner checks for. A file of its own,
 * without imports, so the scripted Hermes (`testing/scripted-hermes.ts`, run by Node as it is) answers `--version` as
 * the pinned release does.
 */
export const HERMES_PIN = {
  version: '0.23.5',
  tag: 'v0.23.5',
  commit: 'a428f5344f777ccafe389c79d5b09384abef1437',
};
