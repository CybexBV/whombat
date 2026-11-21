import { type CatalogEntry, catalogEntry } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors';
import { connectProblem, httpWarning, signInChoices } from './form';
import { guidedSteps, raiseNote } from './setup';
import {
  codeProblemText,
  codeSignInAgain,
  codeSignInOf,
  connectionReason,
  secretWords,
  signingInText,
} from './signInAgain';

const entry = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

const t3 = entry('t3code');
const pairing = t3.signIn.find((m) => m.kind === 'password');
if (pairing?.kind !== 'password') throw new Error('t3code pairing code');

describe('signing in again with a new code (T3 Code, t3code.md)', () => {
  it('offers Sign in again on a T3 Code connection, with the pairing code’s words', () => {
    const again = codeSignInAgain(t3, { signIn: 'token', status: 'active' });
    expect(again).toMatchObject({ title: pairing.label, needs: false, method: pairing });
    expect(again?.words.label).toBe('Pairing code');
    expect(again?.words.placeholder).toBe(pairing.secret?.placeholder);
    expect(again?.words.steps.length).toBeGreaterThan(0);
    expect(again?.line).toContain('pairing code');
    // Needing a new sign-in leads with it.
    const needs = codeSignInAgain(t3, { signIn: 'token', status: 'needs_reauth' });
    expect(needs?.needs).toBe(true);
    expect(needs?.line.startsWith('T3 Code')).toBe(true);
    expect(needs?.line).toContain('pairing code');
  });

  it('leaves every other connection as it is: Replace token, sign in once, a sign-in elsewhere', () => {
    expect(codeSignInOf(entry('proxmox'))).toBeNull();
    expect(codeSignInAgain(entry('proxmox'), { signIn: 'token', status: 'needs_reauth' })).toBeNull();
    expect(codeSignInAgain(entry('pihole'), { signIn: 'token', status: 'active' })).toBeNull();
    expect(codeSignInAgain(entry('plex'), { signIn: 'token', status: 'active' })).toBeNull();
    expect(codeSignInAgain(t3, { signIn: 'none', status: 'active' })).toBeNull();
    // A sign-in with no account but no kept token only for it (or the other way round) isn't one.
    const kept = t3.signIn.map((m) => (m.kind === 'token' ? { ...m, storedOnly: false } : m));
    expect(codeSignInOf({ ...t3, signIn: kept })).toBeNull();
    const withAccount = t3.signIn.map((m) =>
      m.kind === 'password' ? { ...m, account: { label: 'User', placeholder: '', help: '' } } : m,
    );
    expect(codeSignInOf({ ...t3, signIn: withAccount })).toBeNull();
  });

  it('asks for the code before it is sent', () => {
    const again = codeSignInAgain(t3, { signIn: 'token', status: 'active' });
    if (!again) throw new Error('t3code sign in again');
    expect(codeProblemText(again, '  ')).toBe('Pairing code is needed.');
    expect(codeProblemText(again, 'ABCD2345EFGH')).toBeNull();
  });

  it('never tells a T3 Code connection to replace its token', () => {
    const conn = {
      status: 'needs_reauth',
      reauthReason: 'token_invalid',
      signIn: 'token',
      label: 'T3 Code',
    } as const;
    expect(connectionReason(t3, conn)).not.toContain('token');
    expect(connectionReason(t3, conn)).toContain('Sign in again');
    expect(connectionReason(t3, { ...conn, status: 'active' })).toBeNull();
    // Others keep their words.
    expect(connectionReason(entry('todoist'), conn)).toContain('the token');
    expect(connectionReason(entry('pihole'), conn)).toContain('the app password');
  });
});

describe('a secret with its own name in the connect form', () => {
  it('only offers the pairing code, and shows its steps', () => {
    expect(signInChoices(t3).map((c) => c.kind)).toEqual(['password']);
    const steps = guidedSteps(t3, secretWords(pairing), {});
    expect(steps).toHaveLength(pairing.secret?.steps.length ?? -1);
    expect(steps[0]?.values).toEqual([]);
  });

  it('names the pairing code where the form says password', () => {
    expect(httpWarning({ url: 'http://192.168.1.20:3773' }, 'password', pairing)).toContain(
      'the pairing code and Whombat’s key',
    );
    expect(signingInText(t3, pairing)).toContain('pairing code');
    const proxmox = entry('proxmox').signIn.find((m) => m.kind === 'password');
    if (!proxmox) throw new Error('proxmox sign in once');
    expect(signingInText(entry('proxmox'), proxmox)).toContain('Whombat’s key');
    expect(secretWords(proxmox as typeof pairing).label).toBe('Password');
    const refused = new ApiError(
      422,
      'sign_in_refused' as never,
      '',
      {},
      'connections.setSecret',
      {},
      {
        code: 'sign_in_refused',
        reason: 'password',
      },
    );
    expect(connectProblem(refused, undefined, pairing).message).toContain('pairing code');
    expect(connectProblem(refused, undefined, proxmox).message).toContain('password');
  });

  it('raises a T3 Code connection by signing it in again on its page', () => {
    expect(raiseNote(t3)).toContain('pairing code');
    expect(raiseNote(entry('proxmox'))).not.toContain('pairing code');
  });
});
