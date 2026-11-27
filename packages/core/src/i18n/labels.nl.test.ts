import { describe, expect, it } from 'vitest';
import {
  BACKUP_ON_DIFFERENT_LABELS,
  BACKUP_SERVERS_STATE_LABELS,
  backupCountText,
  backupOnDifferentLabels,
  backupRestoreChips,
  backupRestoreSummaryLines,
  backupServersStateLabels,
  backupServersStateText,
} from '../backup/restore.js';
import {
  COMMAND_ALLOWANCES_COPY,
  COMMAND_CATEGORY_LABELS,
  commandAllowanceLine,
  commandAllowancesCopy,
  commandCategoryLabels,
} from '../commands/copy.js';
import {
  AGENT_NAME_FORM_TEXT,
  AGENT_NAME_RESERVED_TEXT,
  agentNameFormText,
  agentNameReservedText,
} from '../domain/agent.js';
import {
  DEPLOYMENT_HOW_LABELS,
  DEPLOYMENT_STATUS_PILLS,
  deployLine,
  deploymentHowLabels,
  deploymentStatusPills,
} from '../domain/deployment.js';
import { featureRequestFrom, featureRequestOutcome, featureValueText } from '../domain/feature-request.js';
import {
  assessmentCardLabel,
  assessmentDetailRows,
  assessmentHeadline,
  evidenceLine,
  FEEDBACK_BUG_VERDICT_LABELS,
  FEEDBACK_DECISION_ACTION_LABELS,
  FEEDBACK_REPRODUCTION_LABELS,
  type FeedbackAssessment,
  feedbackBugVerdictLabels,
  feedbackDecisionActionLabels,
  feedbackReproductionLabels,
} from '../domain/feedback-assessment.js';
import {
  FEEDBACK_ASSESSMENT_STATE_LABELS,
  FEEDBACK_OUTCOME_LABELS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_TYPE_LABELS,
  feedbackAssessmentStateLabels,
  feedbackOutcomeLabels,
  feedbackStatusLabels,
  feedbackTypeLabels,
  reportCardLabel,
  reportCardState,
} from '../domain/feedback-card.js';
import { PR_FILE_SHOWN_TEXT, prFileShownText } from '../domain/file-view.js';
import {
  MESSAGE_DELETED_TEXT,
  MESSAGE_EDITED_LABEL,
  MESSAGE_TOO_LONG,
  messageDeletedText,
  messageEditedLabel,
  messageTooLong,
} from '../domain/message.js';
import { DND_PRESET_LABELS, dndPresetLabels } from '../domain/notify.js';
import {
  PROMPT_COUNCIL_LINES,
  promptCouncilLines,
  STARTER_PROMPTS,
  starterPromptOf,
  starterPrompts,
} from '../domain/prompts.js';
import { PROVIDER_LABELS, providerLabels } from '../domain/providers.js';
import { PR_STATUS_LABELS, prStatusLabels, REVIEW_STATE_LABELS, reviewStateLabels } from '../domain/repo.js';
import { EMOJI_GROUP_LABELS, emojiGroupLabels } from '../text/emoji.js';

describe('label tables in Dutch', () => {
  it('keeps every English constant equal to its function in English', () => {
    const pairs: [unknown, unknown][] = [
      [BACKUP_ON_DIFFERENT_LABELS, backupOnDifferentLabels('en')],
      [BACKUP_SERVERS_STATE_LABELS, backupServersStateLabels('en')],
      [DEPLOYMENT_HOW_LABELS, deploymentHowLabels('en')],
      [DEPLOYMENT_STATUS_PILLS, deploymentStatusPills('en')],
      [DND_PRESET_LABELS, dndPresetLabels('en')],
      [EMOJI_GROUP_LABELS, emojiGroupLabels('en')],
      [FEEDBACK_TYPE_LABELS, feedbackTypeLabels('en')],
      [FEEDBACK_OUTCOME_LABELS, feedbackOutcomeLabels('en')],
      [FEEDBACK_ASSESSMENT_STATE_LABELS, feedbackAssessmentStateLabels('en')],
      [FEEDBACK_STATUS_LABELS, feedbackStatusLabels('en')],
      [FEEDBACK_BUG_VERDICT_LABELS, feedbackBugVerdictLabels('en')],
      [FEEDBACK_DECISION_ACTION_LABELS, feedbackDecisionActionLabels('en')],
      [FEEDBACK_REPRODUCTION_LABELS, feedbackReproductionLabels('en')],
      [MESSAGE_DELETED_TEXT, messageDeletedText('en')],
      [MESSAGE_EDITED_LABEL, messageEditedLabel('en')],
      [MESSAGE_TOO_LONG, messageTooLong('en')],
      [PR_FILE_SHOWN_TEXT, prFileShownText('en')],
      [PR_STATUS_LABELS, prStatusLabels('en')],
      [REVIEW_STATE_LABELS, reviewStateLabels('en')],
      [STARTER_PROMPTS, starterPrompts('en')],
      [PROMPT_COUNCIL_LINES, promptCouncilLines('en')],
      [PROVIDER_LABELS, providerLabels('en')],
      [AGENT_NAME_FORM_TEXT, agentNameFormText('en')],
      [AGENT_NAME_RESERVED_TEXT, agentNameReservedText('en')],
      [COMMAND_CATEGORY_LABELS, commandCategoryLabels('en')],
      [COMMAND_ALLOWANCES_COPY, commandAllowancesCopy('en')],
    ];
    for (const [constant, english] of pairs) expect(constant).toEqual(english);
  });

  it('says the word tables in Dutch', () => {
    expect(backupOnDifferentLabels('nl').replace).toContain('back-up');
    expect(deploymentStatusPills('nl').succeeded).toBe('UITGEROLD');
    expect(deploymentHowLabels('nl').ssh).toBe('SSH');
    expect(dndPresetLabels('nl').tomorrow).toBe('Tot morgen');
    expect(emojiGroupLabels('nl').people).toBe('Mensen');
    expect(feedbackOutcomeLabels('nl').duplicate).toBe('Duplicaat');
    expect(prStatusLabels('nl').merged).toBe('Samengevoegd');
    expect(reviewStateLabels('nl').approved).toBe('Goedgekeurd');
    expect(prFileShownText('nl').binary).toContain('binair');
    expect(messageDeletedText('nl')).toContain('verwijderd');
    expect(agentNameFormText('nl')).toContain('Dusty');
    expect(commandAllowancesCopy('nl').remove).toBe('Verwijderen');
    expect(commandCategoryLabels('nl').merge).toContain('main');
  });

  it('keeps brand names in the provider labels', () => {
    const nl = providerLabels('nl');
    expect(nl.claude).toBe('Claude Code');
    expect(nl.codex).toBe('ChatGPT');
    expect(nl.local).toContain('AI-model');
  });

  it('says the restore in Dutch, with Dutch numbers', () => {
    expect(backupCountText('automations', 1234, 'nl')).toBe('1.234 automatiseringen');
    expect(backupCountText('automations', 1234)).toBe('1,234 automations');
    expect(backupRestoreChips({ id: 'agents', count: 3, new: 2, here: 1, different: 0 }, 'nl')).toEqual([
      { label: '2 nieuw', tone: 'neutral' },
      { label: '1 al hier', tone: 'neutral' },
    ]);
    expect(backupServersStateText({ state: 'blocked', count: 5, blockedBy: 3 }, 'nl')).toContain('3 servers');
    const lines = backupRestoreSummaryLines(
      {
        categories: [{ id: 'automations', added: 9, updated: 0, unchanged: 0, kept: 0, skipped: 0 }],
        automationsOff: 2,
        finishedAt: '2026-11-27T10:00:00.000Z',
      },
      'nl',
    );
    expect(lines[0]).toContain('9 automatiseringen');
    expect(lines[1]).toContain('staan uit');
  });

  it('says a deploy, a report and an assessment in Dutch', () => {
    const deploy = { service: 'api', environment: 'production', status: 'failed', sha: null } as const;
    expect(deployLine(deploy, 'nl')).toContain('mislukt');
    expect(deployLine(deploy)).toBe('Deploy of api to production failed');
    expect(reportCardLabel({ type: 'bug', reference: 'FB-7K3Q-9M2X' }, 'nl')).toBe(
      'BUGMELDING · FB-7K3Q-9M2X',
    );
    const card = {
      product: 'Lumio',
      status: 'new',
      assessment: { state: 'queued', outcome: null, summary: null },
    } as const;
    expect(reportCardState(card, 'nl')).toContain('Nieuw');
    expect(assessmentCardLabel({ reference: 'FB-7K3Q-9M2X' }, 'nl')).toContain('BEOORDELING');
    const headline = {
      outcome: 'duplicate',
      duplicateOf: 'FB-2P7K-8T73',
      confidence: 'high',
      severity: { level: 'none', rationale: '' },
    } as const;
    expect(assessmentHeadline(headline, 'nl')).toContain('hoge zekerheid');
    expect(assessmentHeadline(headline)).toContain('high confidence');
    const evidence = { kind: 'file', ref: 'src/app.ts:12', note: '', hypothesis: true } as const;
    expect(evidenceLine(evidence, 'nl')).toContain('Hypothese');
    const assessment = {
      outcome: 'likely_bug',
      summary: 'S',
      confidence: 'low',
      uncertainty: '',
      reproduction: { status: 'reproduced', notes: '' },
      evidence: [],
      revision: { inspected: null, reported: null, mismatch: null },
      severity: { level: 'high', rationale: '' },
      missingInformation: [],
      nextAction: '',
      duplicateOf: null,
      feature: null,
    } satisfies FeedbackAssessment;
    const rows = assessmentDetailRows(assessment, 'nl');
    expect(rows.map((r) => r.label)).toContain('Ernst');
    expect(rows.find((r) => r.label === 'Ernst')?.text).toBe('hoog');
  });

  it('gives the starter prompts in Dutch with the same keys', () => {
    const nl = starterPrompts('nl');
    expect(nl.map((s) => s.key)).toEqual(STARTER_PROMPTS.map((s) => s.key));
    expect(nl[0]?.title).toBe('Zoek wat stuk is');
    expect(nl[0]?.text).toContain('raad');
    expect(nl.every((s) => !s.text.includes('{council}'))).toBe(true);
    expect(starterPromptOf('starter-audit', 'nl')?.title).toBe('Zoek wat stuk is');
    expect(starterPromptOf('starter-audit')?.title).toBe('Find what’s broken');
  });

  it('says a feature request’s card in Dutch', () => {
    expect(featureValueText(null, 'nl')).toBe('Geen score');
    expect(featureValueText(7)).toBe('7 of 10');
    expect(
      featureRequestFrom({ organization: 'HollowMere College', connection: 'Acme', number: 21 }, 'nl'),
    ).toContain('Van HollowMere College');
    const outcome = featureRequestOutcome(
      { state: 'decided', choice: 'approve', note: '', declineReason: '' },
      null,
      'nl',
    );
    expect(outcome?.lead).toBe('Goedgekeurd door jou');
    expect(commandAllowanceLine({ keyId: 'deploy.production', target: 'web-1' }, 'nl')).toContain(
      'productie',
    );
  });
});
