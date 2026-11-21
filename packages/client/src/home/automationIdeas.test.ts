import { describe, expect, it } from 'vitest';
import { AUTOMATION_IDEAS_MAX, automationIdeas } from './automationIdeas';

describe('what the Automations page suggests (care-plan.md; flows.md 5.1)', () => {
  it('starts from what is connected: mail, a server, Home Assistant', () => {
    const ideas = automationIdeas([
      { kind: 'server', name: 'pve-01' },
      { kind: 'connection', catalogId: 'homeassistant', name: 'Home Assistant' },
      { kind: 'connection', catalogId: 'google', name: 'Mail' },
    ]);
    expect(ideas).toHaveLength(AUTOMATION_IDEAS_MAX);
    expect(ideas[0]).toContain('mail');
    expect(ideas[1]).toContain('pve-01');
    expect(ideas[2]).toContain('light');
  });

  it('never names a server that is part of another, and fills up with everyday ideas', () => {
    const ideas = automationIdeas([
      { kind: 'server', name: 'pve-01' },
      { kind: 'server', name: 'pbs', partOf: 'server:pve-01' },
    ]);
    expect(ideas[0]).toContain('pve-01');
    expect(ideas).toHaveLength(3);
    expect(ideas.join(' ')).not.toContain('pbs');
  });

  it('offers everyday ideas when nothing is connected, and a developer’s only with code connected', () => {
    const none = automationIdeas([]);
    expect(none).toHaveLength(3);
    expect(none.join(' ')).not.toContain('issues');
    expect(automationIdeas([{ kind: 'connection', catalogId: 'github', name: 'GitHub' }])[0]).toContain(
      'issues',
    );
  });
});
