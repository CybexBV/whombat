/**
 * Who uses a connection (less-is-more.md AP-1802; one-agent.md AP-4904): the agent by its name (“Dusty calls it
 * homeassistant”, “WHAT DUSTY MAY DO”), “your agent” until its name is known. Each line is one sentence (AP-1751). Pure.
 */
import { agentFallbackName } from '../agentName';
import { clientTranslator } from '../i18n/catalog';

export interface ConnectionWords {
  /** The agent's name. */
  agent: string;
  /** The overview's first line. */
  intro: string;
  /** Add a connection's line under its title. */
  addHint: string;
  /** GitHub's line on the overview. */
  github: string;
  /**
   * Website feedback's line where its reports come to the person's chat with the agent (feedback-chat.md AP-1834);
   * null: the line of `CONNECTION_PAGES`.
   */
  feedback: string | null;
  /** CONNECTION's line: “6 tools · Dusty calls it homeassistant”. */
  callsLine: (tools: string, handle: string) => string;
  /** The handle's label in CONNECTION. */
  callsIt: string;
  /** The level's label: WHAT DUSTY MAY DO. */
  mayDo: string;
  /** The same as a sentence (a legend, a step's title). */
  mayDoQuestion: string;
  /** A level's line from the catalog (“Agents can also …”), said of the agent. */
  access: (text: string) => string;
  /** TOOLS' one line. */
  toolsHint: (label: string, lookOnly: boolean) => string;
  /** A tool's tiers' accessible name. */
  toolTiers: (tool: string) => string;
  /** The connect form's name help. */
  nameHelp: string;
  /** Sign in once with a service that can't limit a key (CS-07). */
  limitNote: (service: string) => string;
}

export function connectionWords(
  agent: string | null | undefined,
  options: { feedbackChat?: boolean; locale?: string | null } = {},
): ConnectionWords {
  const tr = clientTranslator(options.locale);
  const look = (lookOnly: boolean) => (lookOnly ? tr.t('connections.toolsLookOnly') : '');
  const a = agent?.trim() || agentFallbackName(options.locale);
  const A = a.charAt(0).toUpperCase() + a.slice(1);
  return {
    agent: a,
    intro: tr.t('connections.intro', { agent: a }),
    addHint: tr.t('connections.addHint', { Agent: A }),
    github: tr.t('connections.github', { agent: a }),
    feedback: options.feedbackChat ? tr.t('connections.feedback', { agent: a }) : null,
    callsLine: (tools, handle) => tr.t('connections.callsLine', { tools, agent: a, handle }),
    callsIt: tr.t('connections.callsIt', { AGENT: A.toUpperCase() }),
    mayDo: tr.t('connections.mayDo', { AGENT: A.toUpperCase() }),
    mayDoQuestion: tr.t('connections.mayDoQuestion', { agent: a }),
    access: (text) => text.replace(/^(Agents|Assistenten) /, `${A} `),
    toolsHint: (label, lookOnly) => tr.t('connections.toolsHint', { agent: a, label, look: look(lookOnly) }),
    toolTiers: (tool) => tr.t('connections.toolTiers', { tool, agent: a }),
    nameHelp: tr.t('connections.nameHelp', { agent: a }),
    limitNote: (service) => tr.t('connections.limitNote', { service, agent: a }),
  };
}
