/**
 * Where git's fetches from GitHub go in an agent's shell (docs/decisions/resourceful-agents.md RA-DS72): an
 * `https://github.com/…` URL is fetched through `git-remote-whombat` (`whombat::`), and a push to it stays the URL as it
 * is — a `pushInsteadOf` that names itself keeps git's push URL plain, so a push is exactly what it was without this.
 * The runner gives every command these as command-line config (`GIT_CONFIG_*`).
 */
export const GITHUB_VIA_WHOMBAT: readonly (readonly [string, string])[] = [
  ['url.whombat::https://github.com/.insteadOf', 'https://github.com/'],
  ['url.https://github.com/.pushInsteadOf', 'https://github.com/'],
];
