import { describe, expect, it } from 'vitest';
import { capState, remoteSummary } from './remoteControl';

const rc = (hub: [boolean, boolean], agent: [boolean, boolean]) => ({
  remote_control: { console: hub[0], power: hub[1] },
  agent_policy: { console: agent[0], power: agent[1] },
});

describe('remote control summary', () => {
  it('needs the hub switch and the agent policy', () => {
    expect(capState(rc([false, false], [true, true]), 'console')).toBe('off');
    expect(capState(rc([true, false], [true, true]), 'console')).toBe('on');
    expect(capState(rc([true, false], [false, true]), 'console')).toBe('blocked');
  });

  it('names what works and warns about what the host blocks', () => {
    expect(remoteSummary(rc([false, false], [true, true]))).toEqual({ text: 'Off', warn: false });
    expect(remoteSummary(rc([true, false], [true, true]))).toEqual({ text: 'Console only', warn: false });
    expect(remoteSummary(rc([false, true], [true, true]))).toEqual({ text: 'Power only', warn: false });
    expect(remoteSummary(rc([true, true], [true, true]))).toEqual({ text: 'Console and power', warn: false });
    expect(remoteSummary(rc([true, false], [false, true]))).toEqual({ text: 'Console blocked on host', warn: true });
    expect(remoteSummary(rc([true, true], [true, false]))).toEqual({ text: 'Console on · power blocked on host', warn: true });
    expect(remoteSummary(rc([true, true], [false, true]))).toEqual({ text: 'Power on · console blocked on host', warn: true });
    expect(remoteSummary(rc([false, true], [true, false]))).toEqual({ text: 'Power blocked on host', warn: true });
    expect(remoteSummary(rc([true, true], [false, false]))).toEqual({ text: 'Console and power blocked on host', warn: true });
  });
});
