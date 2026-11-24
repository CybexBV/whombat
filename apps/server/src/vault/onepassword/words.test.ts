/**
 * The titles of a failing 1Password sync (docs/decisions/onepassword-sync.md): each says what its words say, so a card
 * never says “can’t reach” for an answer that didn't read or a worker that stopped, and “can’t find the vault” only
 * when the vault is gone.
 */
import { ONEPASSWORD_WORDS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ONEPASSWORD_PASS_WORDS, onePasswordFailingKind, onePasswordFailingTitle } from './words';

describe('a failing pass’s title', () => {
  it('follows its words', () => {
    expect(onePasswordFailingKind(ONEPASSWORD_WORDS.unreachable)).toBe('unreachable');
    expect(onePasswordFailingKind(ONEPASSWORD_PASS_WORDS.answer)).toBe('answer');
    expect(onePasswordFailingKind(ONEPASSWORD_WORDS.stopped)).toBe('stopped');
    expect(onePasswordFailingKind(ONEPASSWORD_PASS_WORDS.vault)).toBe('vault');
    expect(onePasswordFailingKind(ONEPASSWORD_PASS_WORDS.readVault)).toBe('readVault');
    expect(onePasswordFailingKind(ONEPASSWORD_PASS_WORDS.noVault)).toBe('noVault');
    expect(onePasswordFailingTitle(ONEPASSWORD_PASS_WORDS.answer)).not.toContain('reach');
    expect(onePasswordFailingTitle(ONEPASSWORD_WORDS.stopped)).not.toContain('reach');
    expect(onePasswordFailingTitle(ONEPASSWORD_PASS_WORDS.readVault)).not.toContain('find');
    expect(onePasswordFailingTitle(ONEPASSWORD_PASS_WORDS.noVault)).not.toContain('find');
    expect(onePasswordFailingTitle(ONEPASSWORD_PASS_WORDS.vault)).toContain('find');
  });
});
