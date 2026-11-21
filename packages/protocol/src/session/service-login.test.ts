import { describe, expect, it } from 'vitest';
import { OPERATION_SAFETY } from './operation-safety.js';
import { API_OPERATIONS } from './operations.js';

describe('signing in on the service’s own page over the session (CT-738, CT-744)', () => {
  it('starts and polls as Nextcloud’s login does: app channel, not secret, never resent', () => {
    for (const [op, like] of [
      ['connections.startServiceLogin', 'connections.startNextcloud'],
      ['connections.pollServiceLogin', 'connections.pollNextcloud'],
    ] as const) {
      expect(API_OPERATIONS.get(op), op).toMatchObject({ channel: 'app', secret: false, retry: 'never' });
      expect(OPERATION_SAFETY[op], op).toEqual(OPERATION_SAFETY[like]);
    }
  });
});
