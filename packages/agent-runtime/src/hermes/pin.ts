/**
 * The pinned Hermes release (HE-28): what `pnpm hermes:install` installs and the runner checks for. A file of its own,
 * without imports, so the scripted Hermes (`testing/scripted-hermes.ts`, run by Node as it is) answers `--version` as
 * the pinned release does.
 */
export const HERMES_PIN = {
  version: '0.23.4',
  tag: 'v0.23.4',
  commit: '8fc0374447313e276f6b9a2764bfc750190c966a',
};
