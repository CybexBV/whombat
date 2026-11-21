import { describe, expect, it } from 'vitest';
import { createClient } from '../http/client';
import { createFakeAppliance } from './fake';
import { createSecureSession } from './secure';

describe('operation names on the session (parity G-02)', () => {
  it('sends an endpoint by its key path; the fake refuses a name the runtime doesn’t know', async () => {
    const seen: string[] = [];
    const appliance = createFakeAppliance({
      handle: async (op) => {
        seen.push(op);
        return { status: 200, body: {} };
      },
    });
    const session = createSecureSession({ connector: appliance.connector });
    try {
      const client = createClient({ session });
      await client.skills.library({ params: { burrow: 'b' } }).catch(() => {});
      expect(seen).toEqual(['skills.library']);
      const r = await session.invoke('skills.libraryList', { params: { burrow: 'b' } }, { mutating: false });
      expect((r.body as { error: { code: string } }).error.code).toBe('unknown_op');
    } finally {
      session.close();
    }
  });
});
