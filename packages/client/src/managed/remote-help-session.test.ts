/**
 * Remote help's ops over a real session to a fake appliance (remote-help.md AP-4441): the names the runtime knows, the
 * answers read strictly, a refusal's `details.code`, and a visit's command line through an export stream.
 */
import { describe, expect, it } from 'vitest';
import { createFakeAppliance } from '../session/fake';
import { OperationError, sessionOps } from '../session/managed-ops';
import { createSecureSession } from '../session/secure';
import { remoteHelpApi } from './remote-help';
import { createFakeRemoteHelp } from './remote-help-fake';

function world() {
  const remote = createFakeRemoteHelp();
  const seen: string[] = [];
  const appliance = createFakeAppliance({
    handle: async (op, input, context) => {
      seen.push(op);
      return remote.call(op, input, {
        accountId: 'acc_mara',
        name: 'Mara',
        endpoint: context.endpointId,
        passkeys: [],
      });
    },
    exports: async (op, input) => {
      if (op !== 'remoteHelp.transcript') return null;
      const bytes = remote.transcript((input as { visitId: string }).visitId);
      return bytes ? { contentType: 'text/plain; charset=utf-8', bytes } : null;
    },
  });
  const session = createSecureSession({ connector: appliance.connector });
  return { remote, seen, session };
}

describe('remote help over the session', () => {
  it('turns it on, lists a visit and reads its command line', async () => {
    const { remote, seen, session } = world();
    try {
      const api = remoteHelpApi(session);
      if (!api) throw new Error('no api');
      expect((await api.get()).grant).toBeNull();
      expect(await api.confirmBegin({ level: 'fix', duration: 'week' })).toEqual({
        nonce: null,
        options: null,
      });
      const on = await api.start({ level: 'fix', duration: 'week' });
      expect(on.grant?.level).toBe('fix');
      const id = remote.visit({ who: 'Claude' }) as string;
      const visits = await api.visits();
      expect(visits[0]).toMatchObject({ id, who: 'Claude', level: 'fix' });
      const t = await api.transcript(id);
      expect(t.name).toBe(`whombat-remote-help-${id}.txt`);
      expect(t.text).toContain('root@whombat:~# systemctl restart whombat-voice');
      expect(t.text).not.toContain('\u001b');
      expect((await api.stop()).grant).toBeNull();
      expect(seen).toEqual([
        'remoteHelp.get',
        'remoteHelp.confirmBegin',
        'remoteHelp.start',
        'remoteHelp.visits',
        'remoteHelp.stop',
      ]);
    } finally {
      session.close();
    }
  });

  it('a refusal carries its reason; a visit without a command line is not found', async () => {
    const { remote, session } = world();
    try {
      remote.setEnvironment('prod');
      const refused = await sessionOps
        .remoteHelpStart(session, { level: 'look', duration: 'forever' })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(OperationError);
      expect((refused as OperationError).details).toMatchObject({ code: 'forever_not_allowed' });
      await sessionOps.remoteHelpStart(session, { level: 'look', duration: 'hour' });
      const id = remote.visit() as string;
      await expect(sessionOps.remoteHelpTranscript(session, id)).rejects.toBeTruthy();
    } finally {
      session.close();
    }
  });
});
