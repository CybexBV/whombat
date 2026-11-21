import { bootstrap } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { matchesShareTarget, shareTargetRoute, shareTargets } from './shareTargets';

const sidebar = () => bootstrap().sidebar;

describe('share targets (AP-4984)', () => {
  it('lists the person’s Chat and Feedback room and their branch rooms, newest first', () => {
    const targets = shareTargets(sidebar(), 'Dusty');
    expect(targets.map((t) => t.id)).toEqual(['cnv_dm-dusty', 'cnv_pr482', 'cnv_feedback-mara']);
    expect(targets.find((t) => t.id === 'cnv_dm-dusty')).toMatchObject({ kind: 'dm', title: 'Chat' });
    expect(targets.find((t) => t.id === 'cnv_dm-dusty')?.meta).toContain('Dusty');
    expect(targets.find((t) => t.id === 'cnv_pr482')).toMatchObject({ kind: 'branch', meta: 'PR #482' });
  });

  it('finds a conversation by a word’s start or part of its name', () => {
    const targets = shareTargets(sidebar(), 'Dusty');
    const find = (q: string) => targets.filter((t) => matchesShareTarget(t, q)).map((t) => t.id);
    expect(find('')).toHaveLength(targets.length);
    expect(find('feed')).toEqual(['cnv_feedback-mara']);
    expect(find('invoice')).toEqual(['cnv_pr482']);
    expect(find('#chat')).toEqual(['cnv_dm-dusty']);
    expect(find('nobody')).toEqual([]);
  });

  it('opens the conversation’s own screen once sent', () => {
    const targets = shareTargets(sidebar(), 'Dusty');
    const route = (id: string) => {
      const t = targets.find((x) => x.id === id);
      if (!t) throw new Error(id);
      return shareTargetRoute(t);
    };
    expect(route('cnv_dm-dusty')).toEqual({ name: 'Tabs', params: { screen: 'ChatRoom' } });
    expect(route('cnv_feedback-mara').name).toBe('Feedback');
    expect(route('cnv_pr482')).toEqual({ name: 'Conversation', params: { conversationId: 'cnv_pr482' } });
  });
});
