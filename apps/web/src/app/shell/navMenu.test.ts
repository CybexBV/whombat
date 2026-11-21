/** The places' right-click menus as data (chat-clear.md AP-4500, AP-4501). */
import { describe, expect, it } from 'vitest';
import { type AssistantNavRow, navMenu } from './assistantSidebarModel';

const row = (id: AssistantNavRow['id'], href: string) => ({ id, href });
const owner = { servers: { addHref: '/connections?tab=servers&add=1', rows: [] } };
const member = { servers: { addHref: null, rows: [] } };
const ids = (entries: ReturnType<typeof navMenu>) => entries.map((e) => e.id);

describe('navMenu', () => {
  it('opens Chat’s and Feedback’s Settled, clears them, and settles their finished threads after that', () => {
    expect(ids(navMenu(row('chat', '/chat'), owner))).toEqual(['settled', 'clear', 'settle-finished']);
    expect(navMenu(row('chat', '/chat'), owner)[1]).toMatchObject({ label: 'Clear chats', danger: true });
    // With a Feedback room, its entries follow Chat's below a line (Feedback has no row of its own).
    const both = navMenu(row('chat', '/chat'), { ...owner, feedback: true });
    expect(ids(both)).toEqual([
      'settled',
      'clear',
      'settle-finished',
      'feedback',
      'feedback-settled',
      'clear-feedback',
      'settle-finished-feedback',
    ]);
    expect(both.slice(3).map((e) => e.href)).toEqual(['/feedback', '/feedback?settled=1', null, null]);
    expect(both[3]?.separated).toBe(true);
  });

  it('adds a server only for those who may, and a connection on its own page', () => {
    expect(ids(navMenu(row('dashboard', '/connections'), owner))).toEqual(['add-server', 'add-connection']);
    expect(navMenu(row('dashboard', '/connections'), member)).toEqual([
      { id: 'add-connection', label: 'Add a connection', href: '/connections?connection=add' },
    ]);
    expect(ids(navMenu(row('home', '/'), { servers: null }))).toEqual(['add-connection']);
  });

  it('starts an automation, adds to the Vault, and has nothing for the other places', () => {
    expect(navMenu(row('automations', '/automations'), owner)[0]?.href).toBe('/automations?new=1');
    expect(navMenu(row('vault', '/vault'), owner)[0]?.href).toBe('/vault?add=1');
    for (const id of ['needsYou', 'files', 'settings'] as const)
      expect(navMenu(row(id, '/'), owner)).toEqual([]);
  });
});
