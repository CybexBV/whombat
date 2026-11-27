import { describe, expect, it } from 'vitest';
import { actionCopy } from '../approvals/copy.js';
import { APPROVAL_ASK_WORDS, approvalAskWords } from '../approvals/display.js';
import { AUDIT_KIND_FILTER_LABELS, auditKindFilterLabels, auditLinkLabel } from '../audit/log.js';
import { findMyTriggerDetail, findMyWhenText } from '../automations/findmy.js';
import { AUTOMATION_DOES_LABELS, automationDoesLabels, automationGlance } from '../automations/glance.js';
import { mailTriggerDetail, mailWhenText } from '../automations/mail.js';
import {
  AUTOMATION_PLAN_DECIDED_TEXT,
  AUTOMATION_PLAN_NOT_HERE,
  AUTOMATION_PLAN_STATE_LABELS,
  automationFlow,
  automationPlanDecidedText,
  automationPlanNotHere,
  automationPlanStateLabels,
  definitionGrants,
  planCardText,
  planMessageText,
  planSections,
} from '../automations/plan.js';
import { cronWords, describeSchedule } from '../automations/schedule.js';
import { thingWhenText } from '../automations/thing.js';
import { BACKUP_CATEGORY_LABELS, backupCategoryLabels, formatBackupSize } from '../backup/categories.js';
import {
  BACKUP_FILE_ERROR_CODES,
  BACKUP_FILE_ERROR_TEXT,
  backupFileErrorText,
  backupFileProblem,
} from '../backup/errors.js';
import { backupNoteText, joinAnd } from '../backup/notes.js';
import type { ApprovalAction } from '../domain/approval.js';
import {
  AutomationDefinition,
  type AutomationDefinitionInput,
  GITHUB_EVENT_LABELS,
  STEP_KIND_LABELS,
  ThingTrigger,
} from '../domain/automation.js';
import { BACKUP_PLACE_TEXT, backupPlaceText } from '../domain/backup-places.js';
import { DESK_WORDS, deskWords } from '../domain/desk.js';
import { HOST_WATCH_CHECKS, hostWatchCheckWords } from '../domain/host-watch.js';
import { addUsage, emptyTotals, formatCost, spendLine, spendSummary } from '../domain/spend.js';
import { VOICE_WORDS, voiceWords } from '../domain/voice.js';
import { WEATHER_WORDS, weatherSymbolText, weatherWords, windFrom } from '../domain/weather.js';
import { describeAction } from '../keys/actions.js';
import { KEY_CATALOG, KEY_GROUP_LABELS, KEY_IDS, keyGroupLabels, keyLabel } from '../keys/catalog.js';
import { KEY_TIER_LABELS, keyTierLabels, tierLabel } from '../keys/grants.js';
import { formatAgo, formatDuration, formatLogDay, formatWeekday } from '../text/time.js';
import { vaultEntryProblem } from '../vault/copy.js';
import { ONEPASSWORD_SKIP_TEXT } from '../vault/onepassword.js';
import {
  ONEPASSWORD_WORDS,
  onePasswordCheckedLine,
  onePasswordEntryLine,
  onePasswordGoneTitle,
  onePasswordKeptLine,
  onePasswordRemovalsBody,
  onePasswordSkipText,
  onePasswordStatusLines,
  onePasswordWaitingLine,
  onePasswordWords,
} from '../vault/onepassword-view.js';
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

describe('automation plans, flows and rows', () => {
  const names = {
    agent: 'Dusty',
    conversationTitle: (id: string) => (id === 'cnv_chat' ? 'Chat' : undefined),
    connectionLabel: (id: string) => (id === 'con_tracker' ? 'Acme Desk dev' : undefined),
  };
  const def = (input: Partial<AutomationDefinitionInput>) =>
    AutomationDefinition.parse({
      version: 1,
      conversationId: 'cnv_chat',
      triggers: [{ kind: 'github', event: 'issue_opened', repo: 'acme/web', bots: false }],
      steps: [{ id: 'ask', kind: 'dispatch_agent', prompt: 'Look at {{trigger.text}}', assessment: true }],
      ...input,
    });
  const lines = (sections: ReturnType<typeof planSections>) =>
    sections.map((s) => [s.label, ...s.lines.map((l) => (l.detail ? `${l.text} | ${l.detail}` : l.text))]);

  it('draws the plan card in Dutch while the definition stays English', () => {
    const d = def({ limits: { maxRunsPerDay: 1, maxTokensPerDay: 1_000_000 } });
    const before = JSON.stringify(d);
    expect(lines(planSections(d, [], { ...names, locale: 'nl' }))).toEqual([
      ['WANNEER', 'Een nieuwe issue in acme/web | Niet van bots'],
      ['DUSTY', 'Look at … | Zegt wat het is, hoe belangrijk het is en hoe groot een oplossing zou zijn'],
      ['VRAAGT JOU', 'Niets: het leest alleen en vertelt het je'],
      ['PLAATST', 'Eén thread per issue in Chat | Niets buiten Whombat'],
      ['LIMIET', 'Maximaal 1 keer per dag', 'Maximaal 1.000.000 tokens per dag'],
    ]);
    expect(lines(planSections(d, [], names))[4]).toEqual([
      'LIMIT',
      'At most 1 run a day',
      'At most 1,000,000 tokens a day',
    ]);
    expect(JSON.stringify(d)).toBe(before);
  });

  it('marks the steps of the flow in Dutch', () => {
    const d = def({
      steps: [
        {
          id: 'ask',
          kind: 'dispatch_agent',
          name: 'Fix it',
          prompt: 'Fix',
          workspace: { repo: 'acme/web', access: 'write', branch: 'fix-{{trigger.number}}' },
        },
        {
          id: 'pr',
          kind: 'open_pull_request',
          repo: 'acme/web',
          branch: 'fix-{{trigger.number}}',
          title: 'Fix',
        },
        { id: 'merge', kind: 'merge_pull_request', repo: 'acme/web', number: '{{steps.pr.prNumber}}' },
      ],
    });
    const grants = definitionGrants(d, ['pr.open']);
    const marks = (locale?: string) =>
      automationFlow(d, grants, { ...names, locale }).flatMap((i) =>
        i.kind === 'step' ? [[i.title, ...i.marks.map((m) => m.label)]] : [],
      );
    expect(marks('nl')).toEqual([
      ['Fix it', 'Wijzigt code'],
      ['Opent een pull request in acme/web', 'GitHub', 'Eerst vragen'],
      ['Voegt hem samen zodra de controles slagen', 'Voegt zelf samen'],
    ]);
    expect(marks()).toEqual([
      ['Fix it', 'Changes code'],
      ['Opens a pull request on acme/web', 'GitHub', 'Asks you first'],
      ['Merges it once its checks pass', 'Merges by itself'],
    ]);
  });

  it('says a row of the list in Dutch', () => {
    const d = def({
      triggers: [
        { kind: 'message_posted', conversationId: 'cnv_chat', contains: ['bug'] },
        { kind: 'manual' },
      ],
      steps: [
        { id: 'post', kind: 'post_message', conversation: 'run', text: 'Hi' },
        { id: 'call', kind: 'http_callback', url: 'https://example.com/hook' },
      ],
    });
    const nl = automationGlance(d, { ...names, locale: 'nl' });
    expect(nl.trigger).toBe('Bericht met “bug” en nog 1');
    expect(nl.does.map((t) => t.label)).toEqual(['Plaatst een bericht', 'Roept een URL aan']);
    expect(automationGlance(d, names).trigger).toBe('Message with “bug” and 1 more');
    expect(automationDoesLabels()).toEqual(AUTOMATION_DOES_LABELS);
    expect(automationDoesLabels('nl').fix_auto).toBe('Lost op als het zeker is');
  });

  it('keeps the English words where they were', () => {
    expect(automationPlanStateLabels()).toEqual(AUTOMATION_PLAN_STATE_LABELS);
    expect(automationPlanDecidedText()).toEqual(AUTOMATION_PLAN_DECIDED_TEXT);
    expect(automationPlanNotHere()).toBe(AUTOMATION_PLAN_NOT_HERE);
    for (const [kind, label] of Object.entries(STEP_KIND_LABELS))
      expect(tCore(null, `plan.stepKind.${kind}` as never), kind).toBe(label);
    for (const [event, label] of Object.entries(GITHUB_EVENT_LABELS))
      expect(tCore(null, `plan.when.github.${event}` as never), event).toBe(label);
  });

  it('says the card’s state and words in Dutch', () => {
    expect(automationPlanStateLabels('nl').waiting).toBe('Wacht op jou');
    expect(automationPlanDecidedText('nl').gone).toBe('Deze automatisering is verwijderd.');
    expect(automationPlanNotHere('nl')).toContain('Automatiseringen');
    expect(planCardText('Bugs', true, 'nl')).toBe('Een wijziging in “Bugs”');
    expect(planCardText('Bugs', false)).toBe('Plan: “Bugs”');
    expect(planMessageText(false, 'nl')).toContain('Zo zou ik het instellen');
  });

  it('says mail, thing and Find My triggers in Dutch', () => {
    const mail = { from: 'example.com', attachmentTypes: ['pdf', 'csv'] };
    expect(mailWhenText(mail, undefined, 'nl')).toBe(
      'Als er mail van example.com met een PDF of CSV binnenkomt in je inbox',
    );
    expect(mailWhenText(mail)).toBe('When mail from example.com with a PDF or CSV arrives in your inbox');
    expect(mailWhenText({}, 'you@example.com', 'nl')).toBe(
      'Als er mail binnenkomt in de inbox van you@example.com',
    );
    expect(mailTriggerDetail('you@example.com', 'nl')).toBe('In you@example.com');
    const down = ThingTrigger.parse({ kind: 'thing', event: 'down', kinds: ['server'], forMinutes: 5 });
    expect(thingWhenText(down, 'nl')).toBe('Als een server al 5 minuten uitgevallen is');
    expect(thingWhenText(down)).toBe('When a server has been down for 5 minutes');
    expect(findMyWhenText({ name: 'Mara', change: 'leaves', place: 'Werk' }, 'nl')).toBe(
      'Als Mara Werk verlaat',
    );
    expect(findMyTriggerDetail('Find My · Studio', 'nl')).toBe('Via Find My · Studio');
  });
});

describe('backup files and places', () => {
  it('says each problem in Dutch and keeps the English', () => {
    for (const code of BACKUP_FILE_ERROR_CODES)
      expect(backupFileErrorText(code), code).toBe(BACKUP_FILE_ERROR_TEXT[code]);
    expect(backupFileErrorText('wrong_password', 'nl')).toBe(
      'Met dat wachtwoord gaat dit bestand niet open.',
    );
    expect(backupFileProblem('damaged', 'nl')).toEqual({
      code: 'damaged',
      message: 'Dit bestand is beschadigd of onvolledig.',
    });
  });

  it('counts notes with the locale’s separators', () => {
    expect(backupNoteText({ code: 'drafts', count: 1234 })).toBe(
      '1,234 automations no longer fit this Whombat, so they come back as drafts.',
    );
    expect(backupNoteText({ code: 'drafts', count: 1234 }, 'nl')).toBe(
      '1.234 automatiseringen passen niet meer bij deze Whombat, dus die komen terug als concept.',
    );
    expect(backupNoteText({ code: 'schedules_paused', count: 1 }, 'nl')).toBe(
      '1 schema komt gepauzeerd terug.',
    );
    expect(backupNoteText({ code: 'model_unavailable' }, 'nl')).toContain('standaard van deze Whombat');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
    expect(joinAnd(['a', 'b', 'c'], 'nl')).toBe('a, b en c');
  });

  it('gives the places’ words in Dutch and the same English as before', () => {
    const en = backupPlaceText();
    const flat = (o: object, path = ''): [string, unknown][] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? flat(v, `${path}${k}.`) : [[`${path}${k}`, v]],
      );
    for (const [key, value] of flat(BACKUP_PLACE_TEXT))
      if (typeof value === 'string') expect(flat(en).find(([k]) => k === key)?.[1], key).toBe(value);
    expect(en.setSay('NAS', 'the share x', false)).toBe(
      BACKUP_PLACE_TEXT.setSay('NAS', 'the share x', false),
    );
    expect(en.location.said('qnap', 'x')).toBe(BACKUP_PLACE_TEXT.location.said('qnap', 'x'));
    expect(en.watch.spaceDetail(12.5)).toBe(BACKUP_PLACE_TEXT.watch.spaceDetail(12.5));
    const nl = backupPlaceText('nl');
    expect(nl.moveTitle('NAS')).toBe('Voortaan back-uppen naar NAS?');
    expect(nl.setSay('NAS', null, true)).toBe(
      'Deze Whombat maakt nu back-ups op NAS. De eerste back-up loopt nu.',
    );
    expect(nl.watch.spaceDetail(12.5)).toBe('Nog 12,5 GB over.');
    expect(nl.kind('linux')).toBe('Server');
  });
});

describe('spend', () => {
  const tokens = addUsage(emptyTotals(), { inputTokens: 1_000_000, outputTokens: 200_000 });
  const withCost = addUsage(tokens, { inputTokens: 0, outputTokens: 0, costUsd: 3.4 });

  it('says what the turns used in Dutch', () => {
    expect(formatCost(3.4, 'nl')).toBe('ongeveer $3,40');
    expect(formatCost(0.001, 'nl')).toBe('onder $0,01');
    expect(formatCost(1204, 'nl')).toBe('ongeveer $1.204,00');
    expect(spendSummary(withCost, 'nl')).toBe('1,2M tokens · ongeveer $3,40');
    expect(spendLine(withCost, 'nl')).toBe('Deze week: 1,2M tokens · ongeveer $3,40');
    expect(spendLine(emptyTotals(), 'nl')).toBe('Deze week: geen beurten');
    expect(spendLine(withCost)).toBe('This week: 1.2M tokens · about $3.40');
  });
});

describe('1Password sync', () => {
  it('keeps the English words where they were', () => {
    expect(onePasswordWords()).toEqual(ONEPASSWORD_WORDS);
    for (const [reason, text] of Object.entries(ONEPASSWORD_SKIP_TEXT))
      expect(onePasswordSkipText(reason as keyof typeof ONEPASSWORD_SKIP_TEXT), reason).toBe(text);
  });

  it('says the sync’s lines in Dutch', () => {
    const at = '2026-09-23T12:20:00Z';
    expect(onePasswordWords('nl').syncNow).toBe('Nu synchroniseren');
    expect(onePasswordSkipText('vault_full', 'nl')).toBe('Je kluis is vol');
    expect(onePasswordKeptLine(0, 'nl')).toBe('Nog geen logins of API-tokens gelijk gehouden');
    expect(onePasswordKeptLine(12, 'nl')).toBe('12 logins en API-tokens gelijk gehouden');
    expect(onePasswordCheckedLine(null, at, 'UTC', 'nl')).toBe('Nog niet gecontroleerd');
    expect(onePasswordGoneTitle(1, 'nl')).toBe('1Password zegt dat 1 item weg is');
    expect(onePasswordRemovalsBody(['Bank', 'Mail', 'Shop', 'Git', 'Bus'], 'nl')).toBe(
      'Whombat heeft Bank, Mail, Shop en nog 2 voorlopig in je kluis gehouden. Verwijder ze hier ook, of houd ze alleen in Whombat.',
    );
    expect(onePasswordRemovalsBody(['Bank'])).toBe(
      'Whombat kept Bank in your Vault for now. Remove it here too, or keep it only in Whombat.',
    );
    expect(onePasswordWaitingLine(at, 'UTC', 'nl')).toBe(
      'Wachten op de limiet van 1Password. Volgende poging om 12:20.',
    );
    expect(
      onePasswordStatusLines(
        { outcome: 'failing', problem: null, nextTryAt: null, readOnly: true, removals: null },
        'UTC',
        'nl',
      ),
    ).toEqual([
      'Whombat kan 1Password niet bereiken.',
      'Deze token kan alleen lezen. Maak er een die de 1Password-kluis kan lezen en schrijven.',
    ]);
    expect(onePasswordEntryLine({ state: 'pending' } as never, at, 'UTC', 'nl')).toBe(
      'Wacht om naar 1Password te gaan',
    );
  });
});
