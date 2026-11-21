/** What a fix to the part a tracker releases on its own needs before it counts as live (report-trackers.md TA-155). */
import { describe, expect, it } from 'vitest';
import { neededRevisions, separateOf } from './fixes';

const info = { releasedSeparately: ['agent/', 'deploy/nixos/'], reachesNoCustomer: ['deploy/operations/'] };
const files = (...paths: string[]) => paths.map((path) => ({ path }));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('which part a fix changes', () => {
  it('reads only that part, docs and the repository’s own checks aside', () => {
    expect(
      separateOf(
        files('agent/kiosk/main.rs', 'deploy/nixos/runtime-version', 'deploy/operations/module-sizes.json'),
        info,
      ),
    ).toBe('only');
    expect(separateOf(files('agent/kiosk/main.rs', 'docs/kiosk.md'), info)).toBe('only');
    expect(separateOf(files('agent/kiosk/main.rs', 'src/api/enrol.rs'), info)).toBe('also');
    expect(separateOf(files('src/api/enrol.rs', 'deploy/operations/module-sizes.json'), info)).toBe('none');
    // A path is a folder, not a prefix of a name.
    expect(separateOf(files('agents.md', 'agentic/x.rs'), info)).toBe('none');
    // A driver from before the paths that reach no customer: they count as what the tracker runs.
    expect(
      separateOf(files('agent/x.rs', 'deploy/operations/a.json'), { releasedSeparately: ['agent/'] }),
    ).toBe('also');
  });
});

describe('what an installation must run', () => {
  const health = (revision: string | null, separate: string | null) => ({
    revision,
    separate: separate ? { version: '2.1.0', revision: separate } : null,
  });

  it('where the customer is, the part it offers too, once the tracker says what that is', () => {
    expect(neededRevisions('only', health(A, B), true)).toEqual({ revision: null, separate: B });
    expect(neededRevisions('also', health(A, B), true)).toEqual({ revision: A, separate: B });
    expect(neededRevisions('none', health(A, B), true)).toEqual({ revision: A, separate: null });
    // Not said: a fix to that part alone can't be seen there; one that also changes the tracker goes by its revision.
    expect(neededRevisions('only', health(A, null), true)).toBeNull();
    expect(neededRevisions('also', health(A, null), true)).toEqual({ revision: A, separate: null });
  });

  it('on its way (development for a production report), the source revision alone', () => {
    expect(neededRevisions('only', health(A, B), false)).toEqual({ revision: A, separate: null });
    expect(neededRevisions('only', health(null, B), false)).toBeNull();
  });
});
