/**
 * `whombat://demo/community` (a demo build only; hermes-engine-app.md AP-5478): the community edition's journey on an
 * in-memory community box — Add this phone with a link, then the box over its “direct” session with its own This
 * Whombat and Devices — so the screens can be seen without a box.
 */
export function demoCommunity(url: string | null): boolean {
  return !!url && /^whombat:\/\/demo\/community\b/.test(url);
}

/**
 * Where the community demo starts: `…/community` at Add this phone with a link, `…/community/device` with the fixtures'
 * device link opened (in as Mara).
 */
export function demoCommunityStart(url: string | null): 'join' | 'device' {
  return url && /^whombat:\/\/demo\/community\/device\b/.test(url) ? 'device' : 'join';
}
