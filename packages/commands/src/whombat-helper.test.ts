/** The `whombat` helper (RA-31, one-person.md OP-S112): notify and status; publish and keep-awake are gone (OP-19). */
import { describe, expect, it } from 'vitest';
import { HelperRequest } from './protocol';
import { buildRequest, describeReply, parseArgs } from './whombat-helper.mjs';

describe('the whombat helper', () => {
  it('reads notify and status, and nothing of what services did', () => {
    expect(parseArgs(['notify', 'build', 'done'])).toEqual({ op: 'notify', text: 'build done' });
    expect(parseArgs(['notify', '-'])).toEqual({ op: 'notify', stdin: true });
    expect(parseArgs(['status'])).toEqual({ op: 'status' });
    for (const gone of [
      ['publish', '3000'],
      ['keep-awake', 'on'],
    ])
      expect(() => parseArgs(gone)).toThrow();
  });

  it('sends a notify with its turn and an id of its own, as the runner reads it', async () => {
    const req = await buildRequest({ op: 'notify', text: 'backup finished' }, { WHOMBAT_TURN: 'dsp_abc' });
    expect(HelperRequest.parse(req)).toMatchObject({
      op: 'notify',
      turn: 'dsp_abc',
      text: 'backup finished',
    });
    await expect(buildRequest({ op: 'notify', text: 'x' }, {})).rejects.toThrow(/WHOMBAT_TURN/);
  });

  it('says what the commands reach', () => {
    const status = describeReply(
      { op: 'status' },
      { status: { homeNetworks: ['192.168.1.0/24'], lan: false, docker: true } },
    );
    expect(status).toContain('192.168.1.0/24');
    expect(status).toContain('20000');
  });
});
