/**
 * A Find My timeline over the session (docs/implementation/macos/findmy-timeline.md): its four operations, how a
 * client may ask again after a lost answer, that the assistant's settings leave them alone, and the minor that brings
 * them.
 */
import { describe, expect, it } from 'vitest';
import { assistantSetting } from './assistant-settings/index.js';
import { OPERATION_SAFETY } from './operation-safety.js';
import { API_OPERATIONS, EXPORT_READ_OPS } from './operations.js';
import { FIND_MY_MINOR, FIND_MY_TIMELINE_MINOR, SESSION_PROTOCOL } from './version.js';

const OPS = [
  'connections.findMyTimeline',
  'connections.findMyTimelineSet',
  'connections.findMyTimelineDelete',
  'connections.findMyTimelineMap',
] as const;

describe('a Find My timeline over the session', () => {
  it('is four operations on the connection’s own path', () => {
    for (const op of OPS) {
      const spec = API_OPERATIONS.get(op);
      expect(spec?.endpoint?.path, op).toMatch(
        /^\/burrows\/:burrow\/connections\/:connectionId\/find-my\/timeline/,
      );
      expect(spec?.secret, op).toBe(false);
    }
    expect(
      OPS.map((op) => [API_OPERATIONS.get(op)?.endpoint?.method, API_OPERATIONS.get(op)?.mutating]),
    ).toEqual([
      ['GET', false],
      ['PUT', true],
      ['POST', true],
      ['GET', false],
    ]);
  });

  it('reads a week of days and the map through an export stream', () => {
    expect(EXPORT_READ_OPS).toEqual(
      expect.arrayContaining(['connections.findMyTimeline', 'connections.findMyTimelineMap']),
    );
    expect(EXPORT_READ_OPS).not.toContain('connections.findMyTimelineSet');
  });

  it('asks the reads again, and never resends a change; deleting every day can’t be undone', () => {
    expect(OPS.map((op) => OPERATION_SAFETY[op])).toEqual([
      { destructive: false, retry: 'safe' },
      { destructive: false, retry: 'never' },
      { destructive: true, retry: 'never' },
      { destructive: false, retry: 'safe' },
    ]);
  });

  it('is no setting of the assistant: it reads the timeline through its own tool', () => {
    for (const op of OPS) expect(assistantSetting(op), op).toEqual({ access: 'none' });
  });

  it('comes with session minor 5, after Find My as a connection', () => {
    expect(FIND_MY_TIMELINE_MINOR).toBe(FIND_MY_MINOR + 1);
    expect(SESSION_PROTOCOL.minor).toBeGreaterThanOrEqual(FIND_MY_TIMELINE_MINOR);
  });
});
