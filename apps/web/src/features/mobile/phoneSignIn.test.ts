import { newPhoneHandoffKey, type PhoneHandoffView, phoneHandoffMac } from '@whombat/client/managed';
import { describe, expect, it } from 'vitest';
import { formatDownloadSize } from './copy';
import {
  countdown,
  type HandoffCode,
  initialPhoneSignIn,
  type PhoneSignInEvent,
  type PhoneSignInState,
  POLL_FAILURES_SHOWN,
  phoneSignInReducer,
} from './phoneSignIn';

const key = newPhoneHandoffKey();
const code: HandoffCode = {
  handoffId: 'ph_0123456789',
  link: 'https://app.whombat.com/auth/phone#t=x',
  key,
  expiresAt: 1_000_000,
  appliance: true,
};
const FP = 'AB12-CD34-EF56';
const phone = { label: 'Pixel 9', platform: 'android', fingerprint: FP };

function run(...events: PhoneSignInEvent[]): PhoneSignInState {
  return events.reduce(phoneSignInReducer, initialPhoneSignIn);
}

const created: PhoneSignInEvent = { type: 'created', gen: 1, code };
const view = (v: Partial<PhoneHandoffView>): PhoneSignInEvent => ({
  type: 'polled',
  handoffId: code.handoffId,
  view: {
    handoffId: code.handoffId,
    state: 'waiting',
    expiresAt: '2026-09-30T12:15:00Z',
    report: null,
    ...v,
  },
});
const pairing = (fingerprint = FP, macKey = key, pairingCode = '1234-5678'): PhoneSignInEvent =>
  view({
    state: 'ready',
    report: {
      kind: 'pairing',
      code: pairingCode,
      fingerprint,
      mac: phoneHandoffMac(macKey, code.handoffId, pairingCode, fingerprint),
    },
  });

describe('phone sign-in by QR code (AP-522)', () => {
  it('shows the code once control made one, and drops an answer for an older code', () => {
    expect(run(created)).toMatchObject({ step: 'waiting', code, notice: null });
    const restarted = run(created, { type: 'restart' });
    expect(restarted).toMatchObject({ step: 'starting', gen: 2 });
    // The first request's answer arrives late: nothing changes.
    expect(phoneSignInReducer(restarted, created)).toBe(restarted);
  });

  it('makes a new code when the token runs out unused, not before', () => {
    const shown = run(created);
    expect(phoneSignInReducer(shown, { type: 'tick', now: code.expiresAt - 1 })).toBe(shown);
    expect(phoneSignInReducer(shown, { type: 'tick', now: code.expiresAt })).toMatchObject({
      step: 'starting',
      notice: null,
    });
    // A scanned code no longer needs its token.
    const scanned = run(created, view({ state: 'scanned' }));
    expect(phoneSignInReducer(scanned, { type: 'tick', now: code.expiresAt + 60_000 })).toBe(scanned);
  });

  it('goes scanned → looking up → confirm when the MAC and the fingerprint check out', () => {
    const scanned = run(created, view({ state: 'scanned' }));
    expect(scanned.step).toBe('scanned');
    const looking = phoneSignInReducer(scanned, pairing());
    expect(looking).toMatchObject({ step: 'lookingUp', pairing: { code: '1234-5678', fingerprint: FP } });
    const confirm = phoneSignInReducer(looking, { type: 'lookedUp', handoffId: code.handoffId, phone });
    expect(confirm).toMatchObject({ step: 'confirm', phone, busy: null });
  });

  it('never approves a report whose MAC is wrong: a fresh code says why', () => {
    const other = newPhoneHandoffKey();
    const s = run(created, pairing(FP, other));
    expect(s).toMatchObject({ step: 'starting', notice: 'refused' });
    // A report for a code that named no Whombat can't ask to be let in either.
    const noWhombat = run({ type: 'created', gen: 1, code: { ...code, appliance: false } }, pairing());
    expect(noWhombat).toMatchObject({ step: 'starting', notice: 'refused' });
  });

  it('never approves when the Whombat names another device than the phone reported', () => {
    const s = run(created, pairing(), {
      type: 'lookedUp',
      handoffId: code.handoffId,
      phone: { ...phone, fingerprint: '9999-9999-9999' },
    });
    expect(s).toMatchObject({ step: 'starting', notice: 'refused' });
    // An approve after that is ignored.
    expect(phoneSignInReducer(s, { type: 'approve' })).toBe(s);
  });

  it('lets the phone in only after “Let it in”, and says so', () => {
    const confirm = run(created, pairing(), { type: 'lookedUp', handoffId: code.handoffId, phone });
    const busy = phoneSignInReducer(confirm, { type: 'approve' });
    expect(busy).toMatchObject({ step: 'confirm', busy: 'approve' });
    // A second click while busy changes nothing.
    expect(phoneSignInReducer(busy, { type: 'decline' })).toBe(busy);
    expect(
      phoneSignInReducer(busy, { type: 'decided', handoffId: code.handoffId, approved: true }),
    ).toMatchObject({
      step: 'success',
      phone,
    });
  });

  it('“Not my phone” declines and shows a fresh code', () => {
    const s = run(
      created,
      pairing(),
      { type: 'lookedUp', handoffId: code.handoffId, phone },
      { type: 'decline' },
      { type: 'decided', handoffId: code.handoffId, approved: false },
    );
    expect(s).toMatchObject({ step: 'starting', notice: 'declined' });
  });

  it('keeps the question after a blip, and ends on a request that is gone or changed hands', () => {
    const busy = run(
      created,
      pairing(),
      { type: 'lookedUp', handoffId: code.handoffId, phone },
      { type: 'approve' },
    );
    expect(
      phoneSignInReducer(busy, { type: 'decideFailed', handoffId: code.handoffId, error: 'failed' }),
    ).toMatchObject({ step: 'confirm', busy: null, note: 'failed' });
    expect(
      phoneSignInReducer(busy, {
        type: 'decideFailed',
        handoffId: code.handoffId,
        error: 'fingerprintChanged',
      }),
    ).toMatchObject({ step: 'error', error: { pairing: 'fingerprintChanged' } });
    expect(
      run(created, pairing(), { type: 'lookupFailed', handoffId: code.handoffId, error: 'badCode' }),
    ).toMatchObject({ step: 'error', error: { pairing: 'badCode' } });
  });

  it('is done when the phone needed nothing more', () => {
    expect(run(created, view({ state: 'done', report: { kind: 'signed_in' } }))).toMatchObject({
      step: 'success',
      phone: null,
    });
  });

  it('starts over when the handoff expires or is gone; a scanned one says it took too long', () => {
    expect(run(created, view({ state: 'expired' }))).toMatchObject({ step: 'starting', notice: null });
    const scanned = run(created, view({ state: 'scanned' }));
    expect(
      phoneSignInReducer(scanned, { type: 'pollFailed', handoffId: code.handoffId, code: 'not_found' }),
    ).toMatchObject({ step: 'starting', notice: 'timedOut' });
  });

  it('rides out a few failed polls, then says control is unreachable', () => {
    let s = run(created);
    const fail: PhoneSignInEvent = { type: 'pollFailed', handoffId: code.handoffId, code: 'unavailable' };
    for (let i = 1; i < POLL_FAILURES_SHOWN; i++) s = phoneSignInReducer(s, fail);
    expect(s).toMatchObject({ step: 'waiting', failures: POLL_FAILURES_SHOWN - 1 });
    // A good poll resets the count.
    expect(phoneSignInReducer(s, view({}))).toMatchObject({ step: 'waiting', failures: 0 });
    expect(phoneSignInReducer(s, fail)).toMatchObject({ step: 'error', error: 'unreachable' });
    expect(run(created, { type: 'pollFailed', handoffId: code.handoffId, code: 'signed_out' })).toMatchObject(
      { step: 'error', error: 'signedOut' },
    );
  });

  it('says why making a code failed, and tries again', () => {
    const s = run({ type: 'createFailed', gen: 1, error: 'rateLimited' });
    expect(s).toMatchObject({ step: 'error', error: 'rateLimited' });
    expect(phoneSignInReducer(s, { type: 'restart' })).toMatchObject({ step: 'starting', gen: 2 });
  });
});

describe('the page’s numbers', () => {
  it('counts down in m:ss', () => {
    expect(countdown(300_000, 0)).toBe('5:00');
    expect(countdown(300_000, 228_500)).toBe('1:12');
    expect(countdown(300_000, 400_000)).toBe('0:00');
  });

  it('writes an APK size the way Android does', () => {
    expect(formatDownloadSize(41_234_567)).toBe('41 MB');
    expect(formatDownloadSize(8_412_000)).toBe('8.4 MB');
    expect(formatDownloadSize(950_000)).toBe('950 kB');
  });
});
