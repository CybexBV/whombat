/**
 * Web search on the person's Brave Search key (Whombat web-search.md): the config names the plugin's Brave backend only
 * with a key, the key goes into a 0600 file of the profile (never `config.yaml`), and only the person's turns that may
 * browse get it.
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchContext } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { base } from '../testing/contexts';
import { hermesConfig, WEB_SEARCH_KEY_FILE, WEB_SEARCH_PROVIDER, writeHermesProfile } from './config';
import { turnSearchKey } from './provider';

const KEY = 'BSA-test-key-one';
const context = (webSearch: unknown) => DispatchContext.parse(base({ webSearch }));

describe('web search in a Hermes turn', () => {
  it('names the Brave backend only when the turn searches, and never Hermes’s keyless search', () => {
    const on = hermesConfig({ runtime: 'claude_directsdk', model: 'opus', effort: null, webSearch: true });
    expect(on.web).toEqual({ keyless_fallback: false, search_backend: WEB_SEARCH_PROVIDER });
    const off = hermesConfig({ runtime: 'claude_directsdk', model: 'opus', effort: null });
    expect(off.web).toEqual({ keyless_fallback: false });
  });

  it('keeps the key in a 0600 file of the profile, never in config.yaml, and removes it when the turn has none', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'wb-web-search-'));
    const c = { runtime: 'claude_directsdk' as const, model: 'opus', effort: null };
    const extras = { soul: 'soul', whombat: 'whombat' };
    await writeHermesProfile(profile, { ...c, webSearch: true }, { ...extras, webSearchKey: KEY });
    const file = join(profile, WEB_SEARCH_KEY_FILE);
    expect(readFileSync(file, 'utf8').trim()).toBe(KEY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(profile, 'config.yaml'), 'utf8')).not.toContain(KEY);
    await writeHermesProfile(profile, c, extras);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(profile, 'config.yaml'), 'utf8')).not.toContain(WEB_SEARCH_PROVIDER);
  });

  it('gives the key to the person’s turns that may browse, and to their pod', () => {
    const ctx = context({ v: 1, provider: 'brave', apiKey: KEY });
    expect(turnSearchKey({ context: ctx, network: true }, { outside: false, pod: false })).toBe(KEY);
    expect(turnSearchKey({ context: ctx, network: false }, { outside: false, pod: true })).toBe(KEY);
    expect(turnSearchKey({ context: ctx, network: false }, { outside: false, pod: false })).toBeNull();
    expect(turnSearchKey({ context: ctx, network: true }, { outside: true, pod: false })).toBeNull();
    expect(
      turnSearchKey({ context: context(null), network: true }, { outside: false, pod: false }),
    ).toBeNull();
  });
});
