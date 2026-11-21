import { catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { isProposableEntry, proposeCallRefusal } from './proposed-actions';

function entryOrThrow(id: string) {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`missing catalog entry ${id}`);
  return entry;
}

describe('proposed connection action narrowing', () => {
  it('blocks whombat_servers, t3code, device, and non-callable builtins while allowing ordinary services', () => {
    expect(isProposableEntry(entryOrThrow('whombat_servers'))).toBe(false);
    expect(isProposableEntry(entryOrThrow('t3code'))).toBe(false);
    expect(isProposableEntry(entryOrThrow('device'))).toBe(false);
    expect(isProposableEntry(entryOrThrow('google'))).toBe(false);
    expect(isProposableEntry(entryOrThrow('github'))).toBe(false);

    expect(isProposableEntry(entryOrThrow('paperless'))).toBe(true);
    expect(isProposableEntry(entryOrThrow('moneybird'))).toBe(true);
    expect(isProposableEntry(entryOrThrow('dropbox'))).toBe(true);
    expect(isProposableEntry(entryOrThrow('todoist'))).toBe(true);
    expect(isProposableEntry(entryOrThrow('truenas'))).toBe(true);
  });

  it('refuses disallowed services, DELETE calls, and read-only calls with plain reasons', () => {
    const paperless = entryOrThrow('paperless');
    const dropbox = entryOrThrow('dropbox');
    const truenas = entryOrThrow('truenas');
    const servers = entryOrThrow('whombat_servers');
    const t3 = entryOrThrow('t3code');

    expect(
      proposeCallRefusal(
        servers,
        { name: 'guest_power', access: 'write', origin: 'builtin' },
        { server: 'pve-01', guest: 'pve:101', action: 'start' },
        'servers',
      ),
    ).toContain('can’t be proposed');

    expect(
      proposeCallRefusal(
        t3,
        { name: 't3_thread_launch', access: 'write', origin: 'mcp' },
        { projectId: 'p1', title: 'hi', message: 'run' },
        't3',
      ),
    ).toContain('can’t be proposed');

    expect(
      proposeCallRefusal(
        paperless,
        { name: 'request', access: 'write', origin: 'request' },
        { method: 'DELETE', path: '/api/documents/1/' },
        'paperless',
      ),
    ).toContain('DELETE');

    expect(
      proposeCallRefusal(
        paperless,
        { name: 'request', access: 'write', origin: 'request' },
        { method: 'GET', path: '/api/documents/' },
        'paperless',
      ),
    ).toContain('read-only GET');

    expect(
      proposeCallRefusal(
        paperless,
        { name: 'request', access: 'write', origin: 'request' },
        { method: 'HEAD', path: '/api/documents/' },
        'paperless',
      ),
    ).toContain('read-only HEAD');

    expect(
      proposeCallRefusal(
        dropbox,
        { name: 'files_list', access: 'read', origin: 'adapter' },
        { path: '/' },
        'dropbox',
      ),
    ).toContain('read-only');

    expect(
      proposeCallRefusal(
        dropbox,
        { name: 'files_delete', access: 'write', origin: 'adapter' },
        { path: '/invoice.pdf' },
        'dropbox',
      ),
    ).toContain('files_delete');

    expect(
      proposeCallRefusal(
        truenas,
        { name: 'call', access: 'write', origin: 'socket' },
        { method: 'pool.query', params: [] },
        'truenas',
      ),
    ).toContain('read-only');

    expect(
      proposeCallRefusal(
        truenas,
        { name: 'call', access: 'write', origin: 'socket' },
        { method: 'pool.dataset.delete', params: ['tank/old'] },
        'truenas',
      ),
    ).toContain('pool.dataset.delete');

    // Ordinary write calls pass.
    expect(
      proposeCallRefusal(
        paperless,
        { name: 'request', access: 'write', origin: 'request' },
        { method: 'POST', path: '/api/documents/post_document/' },
        'paperless',
      ),
    ).toBeNull();

    expect(
      proposeCallRefusal(
        dropbox,
        { name: 'files_write', access: 'write', origin: 'adapter' },
        { path: '/notes.txt', text: 'hello' },
        'dropbox',
      ),
    ).toBeNull();
  });
});
