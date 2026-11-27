import { describe, expect, it } from 'vitest';
import { AGENT_FACE_STYLES, agentFaceStyles } from '../agentFace';
import { TIER_SEGMENTS, tierSegments } from '../agentKeys';
import { AUTOMATION_PAGE_TEXT, automationPageText } from '../automationView';
import { AVATAR_COPY, AvatarImageError, avatarCopy, avatarErrorText } from '../avatarPhoto';
import { CHAT_WORDS, chatWords } from '../chat/rooms';
import { SETTLE_WORDS, settleFinishedToast, settleWords } from '../chat/settle';
import { FILES_COPY, filesCopy, filesCountText, folderNameProblem, movedText } from '../files';
import { GATEWAY_TEXT, gatewayText } from '../gateway';
import { handoffWords, OPEN_IN_T3_CODE } from '../handoff';
import { undoOutcome } from '../home/changes';
import { LOOK_PLAN_WORDS, lookPlanWords } from '../home/lookPlan';
import {
  durationWords,
  HISTORY_WORDS,
  historyWords,
  KEEP_QUIET_WORDS,
  keepQuietWords,
  LIMIT_WORDS,
  limitWords,
} from '../home/monitoring';
import { noticeGroups, QUIET_TOASTS, quietToasts } from '../home/quiet';
import { IMAP_COPY, imapConnectedText, imapCopy } from '../imap';
import { JOB_WORDS, jobWords } from '../job';
import { keptSiteUntil } from '../keptSites';
import { LOCAL_MODEL_FIELDS, localModelFields } from '../localModel';
import { LOOKS_AHEAD_TEXT, looksAheadCheckMeta, looksAheadText } from '../looksAhead';
import { MEMORY_TEXT, memoryText } from '../memory';
import { ONEPASSWORD_APP_TEXT, onePasswordAppText } from '../onePassword';
import { PROMPT_WORDS, promptWords } from '../prompts';
import { SHARE_TEXT, shareText } from '../shares';
import {
  ANY_PROVIDER,
  anyProvider,
  REFUSAL_TEXT,
  refusalText,
  SIGNIN_STATES,
  signinStates,
} from '../signins/copy';
import { SKILL_HUB_TEXT, SKILL_LIBRARY_TEXT, skillHubText, skillLibraryText } from '../skillLibrary/model';
import { VAULT_TOTP_TEXT, vaultTotpText } from '../vaultAsk';
import { VAULT_AUTH_LABELS, vaultAuthLabels } from '../vaultForm';
import { VOICE_TEXT, voiceText } from '../voice/model';
import { CHAT_WORK_AREAS } from './messages/chatWork';

/** Words that are the same in Dutch: product names, and loanwords Dutch uses as they are. */
const SAME_IN_DUTCH = new Set([
  'Chat',
  'Feedback',
  'Details',
  'Plan',
  'Branch',
  'Review',
  'Pull request',
  'Pull request #{n}, {state}',
  'Pull request {label} {state}',
  'Pull request #{n} {state}',
  'Model',
  'open',
  '{pr} open',
  'live',
  'Checks',
  'PROMPTS',
  'Prompts',
  'Prompt',
  'GitHub',
  'Mail',
  'Monitoring',
  'Webhook',
  'Server',
  'Skills · {count}',
  '{m} min',
]);

const holes = (value: unknown): string[] =>
  [...new Set(JSON.stringify(value).match(/\{[A-Za-z0-9_]+\}/g) ?? [])].sort();

/** The words of a value, functions left out (a word that fills in is checked by calling it). */
const words = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const leaves = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);

describe('chat and work catalogs', () => {
  it('give every English key a Dutch one with the same placeholders', () => {
    for (const area of CHAT_WORK_AREAS) {
      const nl = area.nl as Record<string, unknown>;
      expect(Object.keys(nl).sort()).toEqual(Object.keys(area.en).sort());
      for (const [key, en] of Object.entries(area.en))
        expect([key, holes(nl[key])]).toEqual([key, holes(en)]);
    }
  });

  it('leave no English in Dutch but the words Dutch shares', () => {
    const left: string[] = [];
    for (const area of CHAT_WORK_AREAS) {
      const nl = area.nl as Record<string, unknown>;
      for (const [key, en] of Object.entries(area.en)) {
        const same = leaves(en).filter(
          (text, i) => leaves(nl[key])[i] === text && /[a-z]{3}/i.test(text.replace(/\{\w+\}/g, '')),
        );
        left.push(...same.filter((text) => !SAME_IN_DUTCH.has(text)).map((text) => `${key}: ${text}`));
      }
    }
    expect(left).toEqual([]);
  });
});

describe('English stays as it was', () => {
  it('keeps every constant equal to its function without a locale', () => {
    expect(words(chatWords())).toEqual(words(CHAT_WORDS));
    expect(words(settleWords())).toEqual(words(SETTLE_WORDS));
    expect(words(jobWords().plan)).toEqual(words(JOB_WORDS.plan));
    expect(words(promptWords())).toEqual(words(PROMPT_WORDS));
    expect(words(shareText())).toEqual(words(SHARE_TEXT));
    expect(words(automationPageText())).toEqual(words(AUTOMATION_PAGE_TEXT));
    expect(words(avatarCopy())).toEqual(words(AVATAR_COPY));
    expect(filesCopy().title).toBe(FILES_COPY.title);
    expect(words(imapCopy())).toEqual(words(IMAP_COPY));
    expect(words(localModelFields())).toEqual(words(LOCAL_MODEL_FIELDS));
    expect(onePasswordAppText().section).toBe(ONEPASSWORD_APP_TEXT.section);
    expect(words(vaultAuthLabels())).toEqual(words(VAULT_AUTH_LABELS));
    expect(vaultTotpText().label).toBe(VAULT_TOTP_TEXT.label);
    expect(words(signinStates())).toEqual(words(SIGNIN_STATES));
    expect(anyProvider()).toBe(ANY_PROVIDER);
    expect(refusalText()['client.not_installed']?.signIn).toBe(REFUSAL_TEXT['client.not_installed']?.signIn);
    expect(skillLibraryText().search).toBe(SKILL_LIBRARY_TEXT.search);
    expect(skillHubText().title).toBe(SKILL_HUB_TEXT.title);
    expect(voiceText().recordingNow).toBe(VOICE_TEXT.recordingNow);
    expect(gatewayText().section).toBe(GATEWAY_TEXT.section);
    expect(looksAheadText().primary).toBe(LOOKS_AHEAD_TEXT.primary);
    expect(memoryText().add).toBe(MEMORY_TEXT.add);
    expect(words(lookPlanWords())).toEqual(words(LOOK_PLAN_WORDS));
    expect(historyWords().title).toBe(HISTORY_WORDS.title);
    expect(keepQuietWords().menu).toBe(KEEP_QUIET_WORDS.menu);
    expect(limitWords().save).toBe(LIMIT_WORDS.save);
    expect(quietToasts().undo).toBe(QUIET_TOASTS.undo);
    expect(words(tierSegments())).toEqual(words(TIER_SEGMENTS));
    expect(words(agentFaceStyles())).toEqual(words(AGENT_FACE_STYLES));
    expect(handoffWords().openInT3Code).toBe(OPEN_IN_T3_CODE);
  });

  it('says counts and joins as before', () => {
    expect(filesCountText(1)).toBe('1 file');
    expect(filesCountText(3)).toBe('3 files');
    expect(anyProvider()).toBe('Claude Code or ChatGPT');
    expect(durationWords(125)).toBe('2 h 5 min');
    expect(settleFinishedToast(0)).toBe('Nothing to settle.');
  });
});

describe('Dutch', () => {
  it('translates the plain words', () => {
    expect(chatWords('nl')).not.toEqual(CHAT_WORDS);
    expect(filesCopy('nl').title).toBe('Bestanden');
    expect(filesCountText(3, 'nl')).toBe('3 bestanden');
    expect(movedText('', 'nl')).toContain('Bestanden');
    expect(anyProvider('nl')).toBe('Claude Code of ChatGPT');
    expect(durationWords(125, 'nl')).toBe('2 u 5 min');
    expect(imapConnectedText('mara@example.com', 'nl')).toContain('mara@example.com');
    expect(imapConnectedText('mara@example.com', 'nl')).toContain('gekoppeld');
    expect(signinStates('nl').ready).toBe('Klaar');
    expect(refusalText('nl')['client.not_installed']?.text('Claude Code')).toContain('Instellingen → AI');
    expect(skillLibraryText('nl').title(3)).toBe('Skills · 3');
    expect(skillHubText('nl').more(2)).toContain('2');
    expect(voiceText('nl').recordingNow).toBe('Opnemen');
    expect(vaultAuthLabels('nl').basic).toContain('wachtwoord');
    expect(keepQuietWords('nl').menu).not.toBe(KEEP_QUIET_WORDS.menu);
    expect(limitWords('nl').save).not.toBe(LIMIT_WORDS.save);
    expect(lookPlanWords('nl').goAhead).toBe('Ga je gang');
  });

  it('fills placeholders in Dutch sentences', () => {
    expect(settleFinishedToast(2, 'nl')).toContain('2');
    expect(settleFinishedToast(2, 'nl')).not.toBe(settleFinishedToast(2));
    expect(keptSiteUntil('2026-11-27T17:40:00Z', Date.parse('2026-11-27T09:00:00Z'), 'UTC', 'nl')).toBe(
      'tot 17:40',
    );
    expect(folderNameProblem('', '', 'nl')).toContain('map');
    expect(avatarErrorText(new AvatarImageError('too_small'), 'nl')).toBe(avatarCopy('nl').tooSmall);
    expect(undoOutcome({ state: 'undone' }, null, 'nl').message).toBe('Ongedaan gemaakt.');
  });

  it('says a recent Looks ahead check in Dutch', () => {
    const meta = looksAheadCheckMeta({ stage: 'eve', state: 'checking', kind: null, feedback: null }, 'nl');
    expect(meta).toContain('Nu bezig');
    expect(meta).not.toContain('Checking');
  });

  it('folds heads-ups and quiet lines in Dutch', () => {
    const line = { nature: 'fyi', tone: 'warn' } as const;
    const groups = noticeGroups([line, line], 'nl');
    expect(groups.foldLabel).toContain('2');
    expect(groups.foldLabel).not.toContain('Show');
    expect(noticeGroups([line, line]).foldLabel).toContain('Show');
  });
});
