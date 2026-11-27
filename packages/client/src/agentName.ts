/**
 * The agent (Whombat one-agent.md OA-01, OA-08; app one-agent.md AP-4900): a Whombat has exactly one, and every screen
 * calls it by its name — “Ask Dusty”, “Reply to Dusty…” — and “your agent” only until the bootstrap is there. Pure,
 * shared by the web and the phone.
 */
/** The agent member of a principal union (`Principal` → `Agent`); any other type as it is. */
export type AgentOf<P> = [Extract<P, { kind: 'agent' }>] extends [never] ? P : Extract<P, { kind: 'agent' }>;

/**
 * The Whombat's agent among a burrow's principals: the one principal of kind `agent` (GitHub, automations and feedback
 * are of kind `system`, OA-17).
 */
export function theAgentOf<P extends { kind: string }>(
  principals: readonly P[] | undefined,
): AgentOf<P> | undefined {
  return principals?.find((p) => p.kind === 'agent') as AgentOf<P> | undefined;
}

import { clientTranslator } from './i18n/catalog';

/** What the agent is called where its name isn't known yet (nothing loaded): never “Whombat”, the box. */
export const AGENT_FALLBACK_NAME = 'your agent';

export function agentFallbackName(locale?: string | null): string {
  return clientTranslator(locale).t('agent.fallbackName');
}

/** The words that mean the agent, with its name. */
export interface AgentWords {
  /** “Dusty”, or “your agent” while unknown. */
  name: string;
  /** The same at the start of a sentence: “Dusty”, “Your agent”. */
  Name: string;
  /** The sidebar's and a thing page's button: “Ask Dusty”. */
  ask: string;
  /** Home's Ask box: “Ask Dusty to check, change or set up anything…”. */
  askPlaceholder: string;
  /** A short Ask box: “Ask Dusty…”. */
  askShort: string;
  /** A chat's composer: “Reply to Dusty…”. */
  reply: string;
  /** Settings → Agent, under the name. */
  nameHint: string;
  /** The toast after a rename: “Dusty is now called Rex.” (with the new name). */
  renamed: (to: string) => string;
  /** The toast after another face (another character): “Rex has a new face and way of talking.” */
  newFace: string;
  /** Chat's line beside its title: “You and Dusty · every question gets its own thread”. */
  chatSub: string;
  /** Chat's composer and the thing pages' new-thread box: “Ask Dusty anything”. */
  chatPlaceholder: string;
  /** Chat with nothing in it yet: “Ask Dusty anything. Each question gets its own thread.” */
  chatEmpty: string;
  /** Under a thread's first message while the agent works on it: “Dusty is looking into it”. */
  lookingIntoIt: string;
  /** The Feedback room's line beside its title: “Reports from your websites · Dusty looks into each one”. */
  feedbackSub: string;
}

export function agentWords(name: string | null | undefined, locale?: string | null): AgentWords {
  const tr = clientTranslator(locale);
  const n = name?.trim() || tr.t('agent.fallbackName');
  const N = n.charAt(0).toUpperCase() + n.slice(1);
  return {
    name: n,
    Name: N,
    ask: tr.t('agent.ask', { name: n }),
    askPlaceholder: tr.t('agent.askPlaceholder', { name: n }),
    askShort: tr.t('agent.askShort', { name: n }),
    reply: tr.t('agent.reply', { name: n }),
    nameHint: tr.t('agent.nameHint', { Name: N }),
    renamed: (to) => tr.t('agent.renamed', { Name: N, to }),
    newFace: tr.t('agent.newFace', { Name: N }),
    chatSub: tr.t('agent.chatSub', { name: n }),
    chatPlaceholder: tr.t('agent.chatPlaceholder', { name: n }),
    chatEmpty: tr.t('agent.chatEmpty', { name: n }),
    lookingIntoIt: tr.t('agent.lookingIntoIt', { Name: N }),
    feedbackSub: tr.t('agent.feedbackSub', { Name: N }),
  };
}
