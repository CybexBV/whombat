/**
 * Who uses a connection (less-is-more.md AP-1802; one-agent.md AP-4904): the agent by its name (“Dusty calls it
 * homeassistant”, “WHAT DUSTY MAY DO”), “your agent” until its name is known. Each line is one sentence (AP-1751). Pure.
 */
import { AGENT_FALLBACK_NAME } from '../agentName';

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
  options: { feedbackChat?: boolean } = {},
): ConnectionWords {
  const look = (lookOnly: boolean) =>
    lookOnly ? ' It’s set to Look only, so everything that changes things stays off.' : '';
  const a = agent?.trim() || AGENT_FALLBACK_NAME;
  const A = a.charAt(0).toUpperCase() + a.slice(1);
  return {
    agent: a,
    intro: `Services ${a} can use for you.`,
    addHint: `${A} uses it as soon as it’s connected.`,
    github: `Repositories, branches and pull requests for ${a}.`,
    feedback: options.feedbackChat
      ? `A feedback button on your website; reports come to your chat with ${a}.`
      : null,
    callsLine: (tools, handle) => `${tools} · ${a} calls it ${handle}`,
    callsIt: `${A.toUpperCase()} CALLS IT`,
    mayDo: `WHAT ${A.toUpperCase()} MAY DO`,
    mayDoQuestion: `What may ${a} do?`,
    access: (text) => text.replace(/^Agents /, `${A} `),
    toolsHint: (label, lookOnly) =>
      `What ${a} may do with ${label}: Allowed runs at once, Asks waits for you, Off never runs.${look(lookOnly)}`,
    toolTiers: (tool) => `${tool}: what ${a} may do`,
    nameHelp: `How it’s listed here and how ${a} sees it. You can change it later.`,
    limitNote: (service) =>
      `${service} can’t limit Whombat’s key itself, so Whombat keeps ${a} to the level you choose.`,
  };
}
