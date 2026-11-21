/**
 * Does an event fire a trigger? Pure: the server reads the signed `events` table in order and turns each event
 * into `TriggerFacts`; everything about loops and authority (causal depth, the automation's own events, who the
 * author is) is decided by the server before it gets here.
 */
import type { AutomationTrigger, GitHubTriggerEvent, TrackerTriggerEvent } from '../domain/automation.js';
import type { TrackerItemKind } from '../domain/tracker.js';
import { globMatch } from '../keys/engine.js';
import { type MailTriggerFacts, mailTriggerMatches } from './mail.js';

export type TriggerFacts =
  | {
      kind: 'message';
      conversationId: string;
      text: string;
      authorKind: 'person' | 'agent';
      mentions: readonly string[];
      isReply: boolean;
    }
  | { kind: 'reaction'; conversationId: string; value: string }
  | {
      kind: 'github';
      event: GitHubTriggerEvent;
      repo: string;
      branch: string | null;
      checksState: string | null;
      /** A draft pull request (0.66). Absent: not a draft. */
      draft?: boolean;
      /** Opened by a bot account (0.66). Absent: a person. */
      bot?: boolean;
      /**
       * A `pr_opened` that is a draft marked ready for review (0.66): only triggers that leave drafts out
       * (`drafts: false`) fire on it — the others fired when it was opened.
       */
      readied?: boolean;
    }
  /** A new report in a tracker connection (0.69, CT-325, TA-04): the `tracker.item_opened` event. */
  | { kind: 'tracker'; event: TrackerTriggerEvent; connectionId: string; itemKind: TrackerItemKind }
  /** A matching incoming email in a connected mailbox. */
  | MailTriggerFacts;

export function triggerMatches(trigger: AutomationTrigger, facts: TriggerFacts): boolean {
  switch (trigger.kind) {
    case 'message_posted': {
      if (facts.kind !== 'message' || facts.conversationId !== trigger.conversationId) return false;
      if (facts.authorKind === 'agent' && !trigger.includeAgents) return false;
      if (facts.isReply && !trigger.includeReplies) return false;
      if (trigger.mentionsId && !facts.mentions.includes(trigger.mentionsId)) return false;
      if (trigger.contains.length === 0) return true;
      const text = facts.text.toLowerCase();
      return trigger.contains.some((w) => text.includes(w.toLowerCase()));
    }
    case 'reaction_added':
      return (
        facts.kind === 'reaction' &&
        facts.conversationId === trigger.conversationId &&
        facts.value === trigger.value
      );
    case 'github': {
      if (facts.kind !== 'github' || facts.event !== trigger.event) return false;
      if (facts.repo.toLowerCase() !== trigger.repo.toLowerCase()) return false;
      if (trigger.branch && (!facts.branch || !globMatch(trigger.branch, facts.branch))) return false;
      if (
        trigger.event === 'checks_completed' &&
        trigger.checksState &&
        facts.checksState !== trigger.checksState
      )
        return false;
      if (trigger.bots === false && facts.bot) return false;
      if (trigger.drafts === false ? facts.draft : facts.readied) return false;
      return true;
    }
    case 'tracker':
      return (
        facts.kind === 'tracker' &&
        facts.event === trigger.event &&
        facts.connectionId === trigger.connectionId &&
        (!trigger.itemKinds || trigger.itemKinds.includes(facts.itemKind))
      );
    case 'mail':
      return facts.kind === 'mail' && mailTriggerMatches(trigger, facts);
    default:
      return false;
  }
}
