import { describe, expect, it } from 'vitest';
import { CHAT_TITLE_MAX, chatTitleFrom, chatTopic, clipTitle, roomTopic } from './title';

describe('task chat titles (ONE-06, CT-337)', () => {
  it('takes the first line of the first message', () => {
    expect(chatTitleFrom('\n  Why is pve-02 so hot?  \nIt was fine yesterday.')).toBe(
      'Why is pve-02 so hot?',
    );
    expect(chatTitleFrom('# **Restart** the `nas`')).toBe('Restart the nas');
    expect(chatTitleFrom('   \n  ')).toBe('New chat');
  });

  it('clips a given title to one line of at most 60 characters', () => {
    const long = 'Keep an eye on the heat pump temperatures and tell me when the flow drops below normal';
    expect(clipTitle(long).length).toBeLessThanOrEqual(CHAT_TITLE_MAX);
    expect(clipTitle(long).endsWith('…')).toBe(true);
    expect(clipTitle('  NAS\n disk   check ')).toBe('NAS disk check');
  });

  it('tells the turn what the chat is about', () => {
    const topic = chatTopic('Check pve-02', { kind: 'server', id: 'pve-02', name: 'pve-02' });
    expect(topic).toContain('“Check pve-02”');
    expect(topic).toContain('server:pve-02');
    expect(topic).toContain('pin_widget');
    expect(topic).toContain('watch_checks');
    expect(chatTopic('Lights', null)).toBe('Task chat “Lights”.');
  });

  it('tells a turn in Chat whose room it is and what its thread is about (CHT-05)', () => {
    const topic = roomTopic('chat', 'Mara', { kind: 'server', id: 'srv_1', name: 'pve-02' });
    expect(topic).toContain('Mara');
    expect(topic).toContain('This thread is about the server pve-02.');
    expect(topic).toContain('server:srv_1');
    expect(roomTopic('chat', 'Mara', null)).not.toContain('about the');
    expect(roomTopic('feedback', 'Mara', null)).toContain('report');
  });
});
