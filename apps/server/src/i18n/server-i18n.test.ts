/**
 * The server in Dutch: each area's words in `nl`, English exactly as before, and the checks that must never read words
 * (the lock, Ignore episodes, backup reasons) working the same in both.
 */
import { describe, expect, it } from 'vitest';
import { screenViews, trimView } from '../desk/widgets/resolve';
import type { Resolved } from '../desk/widgets/types';
import { buildPushPreview, genericPushText, notificationPushTitle } from '../domain/push-preview';
import { foundPhrase } from '../guides/welcome';
import { backupProposal, lateBackupItem, restoreStoppedItem } from '../home/box-backup';
import { englishOf, localizeHubJson, rememberEnglish, statusNoteWords } from '../hosts/localize';
import { countOf, hintGuestNames } from '../hosts/quiet-lines';
import { digestLine, renderDigest } from '../mail/digest';
import { renderEmailHtml } from '../mail/template';
import { restoreStateIn } from '../managed/restore-state';
import {
  noticeIn,
  RESTORE_DONE_NOTICE,
  remoteHelpVisitNotice,
  SECURITY_NOTICES,
} from '../managed/security-push';
import { updateReadyItem } from '../managed/update-inbox';
import { untilWords } from '../things/quiet/words';
import { EN, NL, tServer } from './catalog';
import { localizePhrase, localizeTree } from './phrases';

const SLOTS = /\{(\w+)\}/g;
const slotsOf = (v: unknown): string[] =>
  [...new Set(JSON.stringify(v).matchAll(SLOTS))].map((m) => m[1] ?? '').sort();

describe('the catalog', () => {
  it('has every English key in Dutch, with the same placeholders and plural forms', () => {
    expect(Object.keys(NL).sort()).toEqual(Object.keys(EN).sort());
    for (const [key, en] of Object.entries(EN)) {
      const nl = (NL as Record<string, unknown>)[key];
      expect(nl, key).toBeTruthy();
      expect([...new Set(slotsOf(nl))], key).toEqual([...new Set(slotsOf(en))]);
      if (typeof en !== 'string') expect(Object.keys(nl as object).sort(), key).toEqual(['one', 'other']);
    }
  });
});

describe('Home', () => {
  it('says the action buttons in Dutch', () => {
    expect(tServer('nl-NL', 'home.action.lookIntoIt')).toBe('Uitzoeken');
    expect(tServer('nl-NL', 'home.action.remindTomorrow')).toBe('Herinner me morgen');
    expect(tServer('nl-NL', 'home.action.review')).toBe('Bekijken');
    expect(tServer('nl-NL', 'home.action.goAhead')).toBe('Ga je gang');
    expect(tServer('nl-NL', 'home.action.ask', { assistant: 'Dusty' })).toBe('Vraag Dusty');
    expect(tServer('en-GB', 'home.action.ask', { assistant: 'Dusty' })).toBe('Ask Dusty');
  });

  it('says the backup items in Dutch and leaves English as it was', () => {
    const usb = backupProposal(null, false, 'nl-NL');
    expect(usb.title).toContain('USB-schijf');
    expect(usb.yes).toContain('WHOMBAT-BACKUP');
    expect(backupProposal(null, false).title).toBe('Back up this Whombat to a USB disk?');
    const status = {
      state: 'stale',
      destination: { configured: true, kind: 'sftp' },
      lastSuccess: { at: '2026-11-20T10:00:00Z' },
      lastFailure: null,
      updatedAt: '2026-11-27T10:00:00Z',
    } as unknown as Parameters<typeof lateBackupItem>[0];
    const now = new Date('2026-11-27T10:00:00Z');
    const en = lateBackupItem(status, null, now);
    const nl = lateBackupItem(status, null, now, 'nl-NL');
    expect(en?.title).toBe('This Whombat hasn’t backed up for a while');
    expect(nl?.title).toBe(tServer('nl', 'home.backup.lateTitle'));
    // The Ignore episode is the same thing in both languages.
    expect(nl?.id).toBe(en?.id);
    expect(nl?.actions[0]?.label).toBe('Back-ups bekijken');
  });

  it('gives the update waiting for the owner in Dutch', () => {
    const item = updateReadyItem('0.320.0', '2026-11-27T10:00:00Z', 'nl-NL');
    expect(item.title).toBe('Er staat een update klaar');
    expect(item.id).toBe(updateReadyItem('0.320.0', '2026-11-27T10:00:00Z').id);
  });
});

describe('servers', () => {
  const alert = {
    id: 'a1',
    rule: 'disk.space_high',
    title: '/data 91% full',
    detail: '910 GB of 1,000 GB used',
    code: 'disk.space_high',
    params: { volume: '/data', pct: 91, usedGB: 910, totalGB: 1000 },
  };

  it('says a hub alert from its code and keeps the English beside it', () => {
    const said = localizeHubJson(alert, 'nl-NL');
    expect(said.title).toBe('/data voor 91% vol');
    expect(said.detail).toContain('gebruikt');
    expect((said as unknown as { _en: { title: string } })._en.title).toBe('/data 91% full');
    // English, or nothing to go by, stays as the hub said it.
    expect(localizeHubJson(alert, 'en-GB')).toBe(alert);
    const unknown = { ...alert, code: 'something.new' };
    expect(localizeHubJson(unknown, 'nl-NL').title).toBe('/data 91% full');
  });

  it('says status notes from their code', () => {
    expect(statusNoteWords('disk_space', {}, 'nl-NL')).toBe('schijfruimte');
    expect(statusNoteWords('temperature', { sensor: 'CPU' }, 'nl-NL')).toContain('CPU');
  });

  it('keeps an Ignore language independent: the English is remembered for the hint', () => {
    const mapped = { title: 'x' };
    rememberEnglish(mapped, {
      title: 'Disk wear high',
      detail: 'Worn 80%',
      _en: { title: 'Disk wear high', detail: 'Worn 80%' },
    });
    expect(englishOf(mapped)?.title).toBe('Disk wear high');
  });

  it('reads counts and guest names in either language', () => {
    expect(countOf('1,234 errors')).toBe(1234);
    expect(countOf('1.234 fouten')).toBe(1234);
    expect(hintGuestNames('web, db en cache')).toEqual(['web', 'db', 'cache']);
    // English lists keep their shape, so an Ignore made before languages still matches.
    expect(hintGuestNames('web, db')).toEqual(['web', 'db']);
    expect(hintGuestNames('web, db, …')).toBeNull();
  });
});

describe('guides', () => {
  it('names what it found with de and het', () => {
    const find = (catalogId: string) => ({
      catalogId,
      host: '10.100.0.5',
      port: 5000,
      url: 'https://10.100.0.5',
      version: null,
    });
    expect(foundPhrase([find('synology')], 'nl-NL')).toBe('een Synology-NAS');
    expect(foundPhrase([find('synology')])).toBe('a Synology NAS');
    expect(tServer('nl', 'guides.spoken.synology.the')).toBe('de Synology-NAS');
  });
});

describe('mail', () => {
  it('marks the page Dutch and says its own words in Dutch', () => {
    const html = renderEmailHtml({ label: 'Test', title: 'Hallo', blocks: [], locale: 'nl-NL' });
    expect(html).toContain('<html lang="nl"');
    expect(renderEmailHtml({ label: 'Test', title: 'Hi', blocks: [] })).toContain('<html lang="en"');
  });

  it('writes the digest in Dutch', () => {
    const item = {
      kind: 'mention' as const,
      actorName: 'Joris',
      where: '#billing',
      text: 'Kijk even',
      url: 'https://app.example.com/x',
      toYou: false,
    };
    expect(digestLine(item)).toBe('Joris mentioned you in #billing');
    expect(digestLine(item, 'nl-NL')).toContain('Joris');
    expect(digestLine(item, 'nl-NL')).not.toContain('mentioned');
    const nl = renderDigest({
      name: 'Mara',
      items: [item],
      cadence: 'daily',
      openUrl: 'https://app.example.com',
      settingsUrl: 'https://app.example.com/settings',
      locale: 'nl-NL',
    });
    expect(nl.html).toContain('lang="nl"');
  });
});

describe('notices and pushes', () => {
  it('says every security notice in Dutch within a push preview', () => {
    for (const notice of [...Object.values(SECURITY_NOTICES), RESTORE_DONE_NOTICE]) {
      const nl = noticeIn(notice, 'nl-NL');
      expect(nl.title).not.toBe(notice.title);
      expect(nl.path).toBe(notice.path);
      expect([...nl.title].length).toBeLessThanOrEqual(80);
      expect([...nl.body].length).toBeLessThanOrEqual(160);
      expect(noticeIn(notice, 'en-GB')).toBe(notice);
    }
    expect(SECURITY_NOTICES.passkeyEnrolled.title).toBe('A new device signed in');
    const visit = noticeIn(remoteHelpVisitNotice('Support is looking', 'Support'), 'nl-NL');
    expect(visit.title).toBe('Support kijkt mee op je Whombat');
  });

  it('gives push titles and the generic lines in the recipient’s language', () => {
    expect(notificationPushTitle('mention', 'Dusty', 'general')).toBe('Dusty mentioned you in general');
    expect(notificationPushTitle('mention', 'Dusty', 'general', 'nl-NL')).toBe('Dusty noemde je in general');
    expect(notificationPushTitle('needs_you', 'Dusty', 'general', 'nl-NL')).toBe('Actie nodig · general');
    expect(genericPushText('mention', 'nl-NL')).toBe('Iemand noemde je');
    expect(genericPushText('mention')).toBe('Someone mentioned you');
    const preview = buildPushPreview({
      kind: 'reply',
      actor: 'Dusty',
      where: 'Direct',
      text: 'Klaar',
      locale: 'nl',
    });
    expect(preview.title).toBe('Dusty reageerde in Privé');
  });

  it('says why a restore failed from its code, and keeps an unknown code’s sentence', () => {
    const state = {
      phase: 'failed',
      stage: null,
      since: '2026-11-27T10:00:00Z',
      error: 'Another restore is running on this Whombat.',
      reason: 'busy',
      restored: null,
      oldApplianceId: null,
      relogin: [],
      servers: null,
      items: [],
    } as unknown as Parameters<typeof restoreStateIn>[0];
    expect(restoreStateIn(state, 'nl-NL')?.error).toBe(tServer('nl', 'managed.backup.reason.busy'));
    expect(restoreStateIn(state, 'en-GB')).toBe(state);
    const odd = { ...state, reason: 'odd' } as typeof state;
    expect(restoreStateIn(odd, 'nl-NL')?.error).toBe('Another restore is running on this Whombat.');
    const stopped = restoreStoppedItem(
      { phase: 'failed', since: '2026-11-27T10:00:00Z', reason: 'interrupted', error: 'It restarted.' },
      new Date('2026-11-27T11:00:00Z'),
      'nl-NL',
    );
    expect(stopped?.title).toBe(tServer('nl', 'home.restore.stoppedTitle'));
  });
});

describe('the desk', () => {
  const secret: Resolved = {
    view: {
      kind: 'list',
      id: 'w_now',
      title: 'Now playing',
      name: 'Plex',
      mark: 'plex',
      rows: [{ title: 'Dune' }],
    },
    private: true,
    refreshS: 30,
  };
  const figures: Resolved = {
    view: { kind: 'figures', id: 'w_fig', title: 'Memory', items: [{ value: '42%', label: 'Used' }] },
    private: true,
    refreshS: 30,
  };
  const spec = (id: string) => ({ id, type: 'clock' as const, opts: {} });

  it('trims a locked screen by the private mark, in Dutch as in English', () => {
    const resolved = new Map([
      ['w_now', secret],
      ['w_fig', figures],
    ]);
    for (const locale of ['en-GB', 'nl-NL']) {
      const views = screenViews([spec('w_now'), spec('w_fig')], resolved, 'summary', undefined, locale);
      expect(views).toHaveLength(2);
      expect(views.every((v) => v.locked === true)).toBe(true);
      expect(JSON.stringify(views)).not.toMatch(/Dune|42%/);
    }
    const nl = screenViews([spec('w_fig')], resolved, 'summary', undefined, 'nl-NL')[0];
    expect(nl?.title).toBe('Geheugen');
    expect(JSON.stringify(nl)).toContain('Ontgrendel om het te zien');
    expect(trimView(figures, {}, 'summary')?.kind).toBe('figures');
  });

  it('says an unlocked view in Dutch and keeps its machine fields', () => {
    const [view] = screenViews(
      [spec('w_now')],
      new Map([['w_now', secret]]),
      'everything',
      undefined,
      'nl-NL',
    );
    expect(view?.title).toBe('Speelt nu');
    expect(view?.name).toBe('Plex');
    expect((view as { mark?: string } | undefined)?.mark).toBe('plex');
  });
});

describe('things', () => {
  it('says a page’s common words in Dutch and leaves ids, keys and privacy flags alone', () => {
    const page = {
      id: 'connection:con_1',
      title: 'Home Assistant',
      kpis: [{ key: 'memory', label: 'Memory', value: 'Online', private: true, stateKind: 'Online' }],
      actions: [{ id: 'restart', label: 'Restart Plex', allowed: true, value: 'Restart' }],
      note: 'Until it’s back online.',
    };
    const nl = localizeTree(page, 'nl-NL');
    expect(nl.id).toBe(page.id);
    expect(nl.kpis[0]?.label).toBe('Geheugen');
    expect(nl.kpis[0]?.value).toBe('Online');
    expect(nl.kpis[0]?.private).toBe(true);
    expect(nl.kpis[0]?.stateKind).toBe('Online');
    expect(nl.actions[0]?.label).toBe('Plex herstarten');
    expect(nl.actions[0]?.value).toBe('Restart');
    expect(localizeTree(page, 'en-GB')).toBe(page);
  });

  it('matches templates and parts between dots, and leaves unknown words as they were', () => {
    expect(localizePhrase('Part of pve-01', 'nl-NL')).toBe('Onderdeel van pve-01');
    expect(localizePhrase('Connected · used today', 'nl-NL')).toBe('Verbonden · vandaag gebruikt');
    expect(localizePhrase('Today · Something new', 'nl-NL')).toBe('Vandaag · Something new');
    expect(localizePhrase('3 devices', 'nl-NL')).toBe('3 apparaten');
    expect(localizePhrase('1 device', 'nl-NL')).toBe('1 apparaat');
    expect(localizePhrase('Zebra crossing', 'nl-NL')).toBe('Zebra crossing');
  });

  it('says when an Ignore or snooze ends in Dutch', () => {
    const now = new Date('2026-11-27T10:00:00Z');
    expect(untilWords(new Date('2026-11-28T08:00:00Z'), now, 'Europe/Amsterdam', 'nl-NL')).toBe(
      'tot morgen 09:00',
    );
    expect(untilWords(new Date('2026-11-28T08:00:00Z'), now, 'Europe/Amsterdam')).toBe(
      'until tomorrow 09:00',
    );
  });
});
