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

/** What the agent is called where its name isn't known yet (nothing loaded): never “Whombat”, the box. */
export const AGENT_FALLBACK_NAME = 'your agent';

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

export function agentWords(name: string | null | undefined): AgentWords {
  const n = name?.trim() || AGENT_FALLBACK_NAME;
  const N = n.charAt(0).toUpperCase() + n.slice(1);
  return {
    name: n,
    Name: N,
    ask: `Ask ${n}`,
    askPlaceholder: `Ask ${n} to check, change or set up anything…`,
    askShort: `Ask ${n}…`,
    reply: `Reply to ${n}…`,
    nameHint: `One word with a capital first letter. ${N} answers you in your chat and looks after your servers and connections.`,
    renamed: (to) => `${N} is now called ${to}.`,
    newFace: `${N} has a new face and way of talking.`,
    chatSub: `You and ${n} · every question gets its own thread`,
    chatPlaceholder: `Ask ${n} anything`,
    chatEmpty: `Ask ${n} anything. Each question gets its own thread.`,
    lookingIntoIt: `${N} is looking into it`,
    feedbackSub: `Reports from your websites · ${N} looks into each one`,
  };
}
