import { describe, expect, it } from 'vitest';
import { actionCopy } from '../approvals/copy.js';
import { APPROVAL_ASK_WORDS, approvalAskWords } from '../approvals/display.js';
import { AUDIT_KIND_FILTER_LABELS, auditKindFilterLabels, auditLinkLabel } from '../audit/log.js';
import { cronWords, describeSchedule } from '../automations/schedule.js';
import { BACKUP_CATEGORY_LABELS, backupCategoryLabels, formatBackupSize } from '../backup/categories.js';
import type { ApprovalAction } from '../domain/approval.js';
import { DESK_WORDS, deskWords } from '../domain/desk.js';
import { HOST_WATCH_CHECKS, hostWatchCheckWords } from '../domain/host-watch.js';
import { VOICE_WORDS, voiceWords } from '../domain/voice.js';
import { WEATHER_WORDS, weatherSymbolText, weatherWords, windFrom } from '../domain/weather.js';
import { describeAction } from '../keys/actions.js';
import { KEY_CATALOG, KEY_GROUP_LABELS, KEY_IDS, keyGroupLabels, keyLabel } from '../keys/catalog.js';
import { KEY_TIER_LABELS, keyTierLabels, tierLabel } from '../keys/grants.js';
import { formatAgo, formatDuration, formatLogDay, formatWeekday } from '../text/time.js';
import { vaultEntryProblem } from '../vault/copy.js';
import { coreTranslator, EN, NL, tCore } from './catalog.js';
import { extractPlaceholders, type MessageValue } from './engine.js';

const plural = (v: MessageValue): v is Exclude<MessageValue, string> => typeof v !== 'string';

describe('core catalog parity', () => {
  it('has the same keys in English and Dutch', () => {
    expect(Object.keys(NL).sort()).toEqual(Object.keys(EN).sort());
  });

  it('keeps each message’s shape and placeholders', () => {
    for (const [key, en] of Object.entries(EN) as [string, MessageValue][]) {
      const nl = (NL as Record<string, MessageValue>)[key];
      expect(nl, key).toBeDefined();
      if (nl === undefined) continue;
      expect(plural(nl), key).toBe(plural(en));
      if (!plural(en) || !plural(nl)) {
        expect(extractPlaceholders(nl).sort(), key).toEqual(extractPlaceholders(en).sort());
        continue;
      }
      expect(extractPlaceholders(nl.other).sort(), key).toEqual(extractPlaceholders(en.other).sort());
      // `one` may leave out the count (“een item”), never add a placeholder.
      for (const name of extractPlaceholders(nl.one ?? nl.other))
        expect(extractPlaceholders(en.other), key).toContain(name);
    }
  });

  it('has no empty message', () => {
    for (const catalog of [EN, NL] as Record<string, MessageValue>[])
      for (const [key, value] of Object.entries(catalog)) {
        const texts = plural(value) ? Object.values(value) : [value];
        for (const text of texts) expect(text?.trim().length, key).toBeGreaterThan(0);
      }
  });
});

describe('time', () => {
  const at = '2026-09-23T10:00:00Z';
  it('names days and spans in Dutch', () => {
    expect(formatWeekday(at, 'UTC', 'nl')).toBe('woensdag');
    expect(formatWeekday(at, 'UTC')).toBe('Wednesday');
    expect(formatAgo('2026-09-23T07:00:00Z', at, 'UTC', 'nl')).toBe('3 uur geleden');
    expect(formatAgo('2026-09-21T10:00:00Z', at, 'UTC', 'nl')).toContain('dagen geleden');
    expect(formatLogDay(at, at, 'UTC', 'nl')).toContain('VANDAAG');
    expect(formatDuration(75_000, 'nl')).toMatch(/1/);
  });

  it('pseudo-localizes', () => {
    expect(formatWeekday(at, 'UTC', 'pseudo')).toMatch(/^\[.*\]$/);
    expect(tCore('pseudo', 'time.weekday.3')).not.toBe('Wednesday');
  });
});

describe('weather', () => {
  it('keeps the English words and has Dutch ones', () => {
    expect(weatherWords('en')).toEqual(WEATHER_WORDS);
    expect(weatherSymbolText('clearsky_day', 'nl')).toBe('Onbewolkt');
    expect(weatherSymbolText('clearsky_day')).toBe('Clear sky');
    expect(windFrom(90, 'nl')).toBe('O');
    expect(windFrom(90)).toBe('E');
  });
});

describe('desk and voice', () => {
  it('keeps English and says it in Dutch', () => {
    expect(deskWords('en')).toEqual(DESK_WORDS);
    expect(deskWords('nl').box.used).toBe('{n} % gebruikt');
    expect(voiceWords('en')).toEqual(VOICE_WORDS);
    const nl = voiceWords('nl').dutchVoice.dialog.restrictions;
    expect(nl).toHaveLength(VOICE_WORDS.dutchVoice.dialog.restrictions.length);
    expect(nl[0]).not.toBe(VOICE_WORDS.dutchVoice.dialog.restrictions[0]);
  });
});

describe('keys', () => {
  it('has the catalog’s English words', () => {
    for (const id of KEY_IDS) {
      expect(EN[`key.label.${id}` as keyof typeof EN], id).toBe(KEY_CATALOG[id].label);
      expect(EN[`key.description.${id}` as keyof typeof EN], id).toBe(KEY_CATALOG[id].description);
    }
    expect(keyGroupLabels('en')).toEqual(KEY_GROUP_LABELS);
    expect(keyTierLabels('en')).toEqual(KEY_TIER_LABELS);
  });

  it('says them in Dutch', () => {
    expect(keyLabel('mail.send', 'nl')).toBe('E-mails versturen');
    expect(keyLabel('mail.send')).toBe('Send emails');
    expect(tierLabel('ask', 'nl')).toBe('Eerst vragen');
    expect(tierLabel('can', 'nl')).toBe('Ga je gang');
    expect(keyGroupLabels('nl').burrow).toBe('Deze Whombat');
  });
});

describe('approvals', () => {
  const deploy = {
    type: 'deploy',
    params: {
      environment: 'staging',
      service: 'billing-api',
      ref: 'feat/invoice-pdf',
      sha: null,
      repo: null,
    },
  } as unknown as ApprovalAction;

  it('words an action as whole Dutch sentences', () => {
    expect(describeAction(deploy, 'nl')).toBe('feat/invoice-pdf uitrollen naar staging');
    expect(actionCopy(deploy, undefined, undefined, 'nl').title).toBe(
      'feat/invoice-pdf uitrollen naar staging',
    );
    expect(actionCopy(deploy).title).toBe('Deploy feat/invoice-pdf to staging');
  });

  it('keeps the English ask words', () => {
    expect(approvalAskWords('en')).toEqual(APPROVAL_ASK_WORDS);
    expect(approvalAskWords('nl').no).toBe('Nee');
  });
});

describe('schedules', () => {
  it('reads cron in Dutch with 1e, 2e, 3e', () => {
    expect(cronWords('0 16 * * 5', 'nl')).toBe('Elke vrijdag om 16:00');
    expect(cronWords('30 8 * * 1-5', 'nl')).toBe('Elke werkdag om 08:30');
    expect(cronWords('0 9 1 * *', 'nl')).toBe('Op de 1e van elke maand om 09:00');
    expect(cronWords('0 9 2 * *', 'nl')).toBe('Op de 2e van elke maand om 09:00');
    expect(cronWords('0 9 2 * *')).toBe('On the 2nd of every month at 09:00');
    expect(cronWords('0 9 * * 1,4', 'nl')).toBe('Elke maandag en donderdag om 09:00');
    expect(describeSchedule({ kind: 'interval', everyMinutes: 30 } as never, 'UTC', 'nl')).toBe(
      'Elke 30 minuten',
    );
    expect(describeSchedule({ kind: 'cron', expr: '0 0 1 1 *' } as never, 'UTC', 'nl')).toBe(
      'Volgens een eigen schema',
    );
  });
});

describe('audit viewer', () => {
  it('keeps English labels and has Dutch ones', () => {
    expect(auditKindFilterLabels('en')).toEqual(AUDIT_KIND_FILTER_LABELS);
    expect(auditKindFilterLabels('nl').blocked).toBe('Geblokkeerd');
    expect(auditLinkLabel({ type: 'pr', number: 5 } as never, { locale: 'nl' })).toBe('PR #5 openen');
    expect(auditLinkLabel({ type: 'pr', number: 5 } as never)).toBe('Open PR #5');
  });
});

describe('host watch', () => {
  it('has every check’s English words in the catalog', () => {
    for (const c of HOST_WATCH_CHECKS) {
      const name = `hostWatch.name.${c.check}` as keyof typeof EN;
      if (!(name in EN)) continue;
      expect(EN[name], c.check).toBe(c.name);
      expect(EN[`hostWatch.words.${c.check}` as keyof typeof EN], c.check).toBe(c.words);
    }
  });

  it('names checks in Dutch, unknown ones as other', () => {
    const first = HOST_WATCH_CHECKS[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(hostWatchCheckWords(first)).toEqual({ name: first.name, words: first.words });
    expect(hostWatchCheckWords(first, 'nl').name).not.toBe('');
    const unknown = { check: 'nobody.knows' as never, name: 'X', words: 'Y' };
    expect(hostWatchCheckWords(unknown, 'nl').name).toBe(tCore('nl', 'hostWatch.name.host.other'));
  });
});

describe('vault and backups', () => {
  it('reads a failing check in Dutch without matching Dutch text', () => {
    const entry = {
      kind: 'api' as never,
      auth: { type: 'basic' as const },
      check: { status: 'failing' as const },
    };
    const failing = { ...entry, check: { ...entry.check, summary: 'The server rejected the secret (401).' } };
    expect(vaultEntryProblem(failing)).toBe('The password stopped working.');
    expect(vaultEntryProblem(failing, 'nl')).toBe('Het wachtwoord werkt niet meer.');
  });

  it('labels categories and sizes', () => {
    expect(backupCategoryLabels('en')).toEqual(BACKUP_CATEGORY_LABELS);
    expect(backupCategoryLabels('nl').vault).toBe('Je kluis');
    expect(formatBackupSize(1_100_000, 'nl')).toBe('1,1 MB');
  });
});

describe('translator', () => {
  it('falls back to English for unknown languages and ignores non-strings', () => {
    expect(coreTranslator('de-DE').language).toBe('en');
    expect(coreTranslator(3 as never).language).toBe('en');
    expect(coreTranslator('nl-BE').language).toBe('nl');
  });
});
