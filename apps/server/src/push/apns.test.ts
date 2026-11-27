import { IOS_LIVE_ACTIVITY_ATTRIBUTES } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { genericPushText } from '../domain/push-preview';
import { apnsOutcome, apnsTopic, buildApnsPayload } from './apns';

describe('APNs payloads', () => {
  it('uses the live-activity topic for every activity push', () => {
    expect(apnsTopic('com.whombat.mobile', false)).toBe('com.whombat.mobile');
    expect(apnsTopic('com.whombat.mobile', true)).toBe('com.whombat.mobile.push-type.liveactivity');
  });

  it('is an alert with the deep link, burrow and inbox row for notifications', () => {
    expect(
      buildApnsPayload({
        title: 'Needs you · #billing-v2',
        body: 'Deploy?',
        path: '/burrow-hq/log?approval=12',
        burrow: 'burrow-hq',
        notificationId: 'ntf_1',
      }),
    ).toEqual({
      aps: { alert: { title: 'Needs you · #billing-v2', body: 'Deploy?' }, 'mutable-content': 1 },
      path: '/burrow-hq/log?approval=12',
      burrow: 'burrow-hq',
      notificationId: 'ntf_1',
    });
  });

  it('says when previews are off, so the app shows its own generic words', () => {
    const off = buildApnsPayload({
      title: 'Whombat',
      body: 'Someone mentioned you',
      path: '/x',
      preview: false,
    });
    expect(off).toMatchObject({ preview: false });
    expect(buildApnsPayload({ title: 'Dusty', body: 'Hi', path: '/x', preview: true })).not.toHaveProperty(
      'preview',
    );
  });

  it('never puts the words it was handed in the alert when previews are off', () => {
    const built = buildApnsPayload({
      kind: 'agent_update',
      title: 'Front door',
      body: 'Alice unlocked the front door',
      path: '/burrow-hq/c/home',
      burrow: 'burrow-hq',
      notificationId: 'ntf_1',
      preview: false,
    });
    const sent = JSON.stringify(built);
    expect(sent).not.toContain('Front door');
    expect(sent).not.toContain('Alice');
    expect(built.aps).toMatchObject({
      alert: { title: 'Whombat', body: genericPushText('agent_update', 'en') },
    });
  });

  it('keeps a generic line in the person’s language when previews are off', () => {
    const dutch = genericPushText('mention', 'nl-NL');
    const built = buildApnsPayload({
      kind: 'mention',
      title: 'Whombat',
      body: dutch,
      path: '/x',
      preview: false,
    });
    expect(built.aps).toMatchObject({ alert: { title: 'Whombat', body: dutch } });
  });

  it('starts an activity with its attributes and an alert, and ends it with a dismissal date', () => {
    const display = { key: 'run:run_1907', label: 'RUN · LIVE' };
    const start = buildApnsPayload({
      title: 'Address review on PR #482',
      body: 'Dusty · Working',
      path: '/burrow-hq/runs/1907',
      event: 'start',
      contentState: display,
      attributesType: IOS_LIVE_ACTIVITY_ATTRIBUTES,
      attributes: { key: 'run:run_1907', kind: 'run', number: 1907, burrow: 'burrow-hq' },
    });
    expect(start.aps).toMatchObject({
      event: 'start',
      'content-state': display,
      'attributes-type': 'WhombatLiveAttributes',
      attributes: { number: 1907 },
      alert: { title: 'Address review on PR #482' },
    });
    const end = buildApnsPayload({ title: '', body: '', path: '/burrow-hq/runs/1907', event: 'end' });
    expect(end.aps).not.toHaveProperty('attributes-type');
    expect((end.aps as { 'dismissal-date': number })['dismissal-date']).toBeGreaterThan(
      (end.aps as { timestamp: number }).timestamp,
    );
  });

  it('strips Live Activity content when preview is false', () => {
    const start = buildApnsPayload({
      title: 'Front door',
      body: 'Alice unlocked the front door',
      path: '/burrow-hq/runs/1907',
      kind: 'direct',
      preview: false,
      event: 'start',
      contentState: { title: 'Alice', text: 'Front door' },
      attributesType: 'WhombatLiveAttributes',
      attributes: { id: 'run-1907' },
    });
    const text = JSON.stringify(start);
    expect(text).not.toContain('Front door');
    expect(text).not.toContain('Alice');
    expect(start.aps).not.toHaveProperty('content-state');
    expect(start.aps).toMatchObject({ alert: { title: 'Whombat' } });
  });
});

describe('APNs answers', () => {
  it('removes a device only when Apple says its token is gone', () => {
    expect(apnsOutcome(200, '')).toBe('sent');
    expect(apnsOutcome(410, JSON.stringify({ reason: 'Unregistered' }))).toBe('prune');
    expect(apnsOutcome(400, JSON.stringify({ reason: 'BadDeviceToken' }))).toBe('prune');
  });

  it('keeps the device when the request or the setup is wrong', () => {
    for (const reason of ['BadTopic', 'DeviceTokenNotForTopic', 'TopicDisallowed', 'PayloadTooLarge'])
      expect(apnsOutcome(400, JSON.stringify({ reason }))).toBe('failed');
    expect(apnsOutcome(400, 'not json')).toBe('failed');
    expect(apnsOutcome(429, JSON.stringify({ reason: 'TooManyRequests' }))).toBe('failed');
  });
});
