import type { ClientStatus, ProviderSignIn } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import type { ClientsList, SignInsList } from '../signins/model';
import { BACKUP_SETUP_TEXT, PROTECT_OTHER_KINDS, protectFoundPlace } from './backup-setup';
import {
  CLAIM_STEPS,
  CONNECT_AI_PROVIDERS,
  CONNECT_AI_TEXT,
  claimStepKicker,
  connectAiStep,
  readyProviders,
} from './claim-steps';
import { COPY } from './copy';

const claude = (installed: boolean): ClientStatus => ({
  provider: 'claude',
  installed: installed ? { version: '2.1.302', installedAt: '2026-10-20T09:00:00Z' } : null,
  latest: null,
  state: installed ? 'installed' : 'not_installed',
  progress: null,
  error: null,
});
const clients = (installed = true): ClientsList => ({ clients: [claude(installed)], checkedAt: null });
const signIns = (...ready: ('claude' | 'codex')[]): SignInsList => ({
  signIns: ready.map(
    (provider) =>
      ({
        provider,
        authMode: provider === 'claude' ? 'subscription_cli' : 'chatgpt',
        createdAt: '2026-10-20T09:00:00Z',
        expiresAt: null,
        verified: 'valid',
        login: null,
        state: 'ready',
        explanation: null,
      }) as ProviderSignIn,
  ),
  logins: [],
  modes: [],
  consoles: [],
});

describe('the claim’s steps (first-day.md)', () => {
  it('are three, numbered on each step', () => {
    expect(CLAIM_STEPS).toEqual(['claim', 'protect', 'ai']);
    expect(COPY.claim.kicker).toBe('CLAIM · STEP 1 OF 3');
    expect(BACKUP_SETUP_TEXT.kicker).toBe('CLAIM · STEP 2 OF 3');
    expect(CONNECT_AI_TEXT.kicker).toBe(claimStepKicker('ai'));
    expect(claimStepKicker('ai')).toBe('CLAIM · STEP 3 OF 3');
  });

  it('offers ChatGPT first: it needs nothing installed', () => {
    expect(CONNECT_AI_PROVIDERS).toEqual(['codex', 'claude']);
  });
});

describe('Connect your AI (first-day.md)', () => {
  const step = (over: Partial<Parameters<typeof connectAiStep>[0]>) =>
    connectAiStep({ signIns: undefined, clients: undefined, failed: false, asked: false, ...over });

  it('checks until both lists are read', () => {
    expect(step({})).toBe('checking');
    expect(step({ signIns: signIns() })).toBe('checking');
  });

  it('asks while nothing is ready', () => {
    expect(step({ signIns: signIns(), clients: clients() })).toBe('ask');
    // Claude Code signed in but not installed (yet) isn't ready.
    expect(step({ signIns: signIns('claude'), clients: clients(false) })).toBe('ask');
  });

  it('is done once a sign-in finishes here; goes straight on when one was ready before', () => {
    expect(step({ signIns: signIns('codex'), clients: clients(), asked: true })).toBe('done');
    expect(step({ signIns: signIns('codex'), clients: clients() })).toBe('go_on');
  });

  it('goes on when a list can’t be read: the Whombat says the rest itself', () => {
    expect(step({ failed: true })).toBe('go_on');
  });

  it('says who is ready, by name', () => {
    expect(readyProviders(clients(), signIns('claude', 'codex'))).toEqual(['codex', 'claude']);
    expect(CONNECT_AI_TEXT.ready(['codex'], 'Dusty')).toContain('ChatGPT');
    expect(CONNECT_AI_TEXT.ready(['codex', 'claude'], 'Dusty')).toContain('ChatGPT and Claude Code');
  });
});

describe('Protect your Whombat offers what is there first (first-day.md)', () => {
  const found = (catalogId: string, host: string, over: { hidden?: boolean; serverIds?: string[] } = {}) => ({
    catalogId,
    host,
    ...over,
  });

  it('a NAS the scan found, in the assistant’s order; not one hidden or added as a server', () => {
    expect(
      protectFoundPlace([
        found('homeassistant', '10.0.0.2'),
        found('qnap', '10.0.0.9'),
        found('synology', '10.0.0.8'),
      ]),
    ).toEqual({
      title: 'The Synology NAS at 10.0.0.8',
      host: '10.0.0.8',
    });
    expect(protectFoundPlace([found('synology', '10.0.0.8', { hidden: true })])).toBeNull();
    expect(protectFoundPlace([found('unraid', '10.0.0.7', { serverIds: ['tower'] })])).toBeNull();
  });

  it('keeps a bucket, SFTP and a REST server under Other places; the disk is its own', () => {
    expect(PROTECT_OTHER_KINDS).toEqual(['s3', 'sftp', 'rest']);
    expect(BACKUP_SETUP_TEXT.places.later('Dusty')).toContain('Dusty');
  });
});
