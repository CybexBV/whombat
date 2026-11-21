/**
 * Static step copy for the onboarding flow (`OB` in `Whombat Desktop.dc.html`): Name your Whombat → Set up your AI →
 * Meet your agent (Whombat one-agent.md OA-13, one-person.md OP-11; app one-agent.md AP-4954, one-person.md AP-5673). Step 2 replaces the mock's
 * “Connect your code” (SUB-08, CT-68); step 3 names the one agent and picks its character (its face and way of
 * talking, agent-voices.md AP-5500) instead of hiring a crew.
 * Stays local to this feature — `@whombat/core/text/copy.ts`'s own rule is "static strings stay in the components;
 * everything that interpolates data lives [in copy.ts]". The tips are the agent's, with its name (`tip`).
 */
export interface OnboardingStepCopy {
  /** Step-list title (aside). */
  t: string;
  /** Step-list description (aside). */
  d: string;
  /** Main-area h1. */
  title: string;
  /** Main-area sub copy. */
  sub: string;
  /** The agent's tip bubble for this step, with its name. */
  tip: (agent: string) => string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepCopy[] = [
  {
    t: 'Name your Whombat',
    d: 'Where you and your agent work',
    title: 'Name your Whombat',
    sub: 'This is where you and your agent work. It shows at the top of the sidebar.',
    tip: (agent) => `Hi, I’m ${agent}. I’ll stick around in case you get stuck.`,
  },
  {
    // Replaces the mock's “Connect your code” (SUB-08, CT-68): choosing the clients and signing in to each.
    t: 'Set up your AI',
    d: 'Pick and sign in',
    title: 'Set up your AI',
    sub: 'Pick the AI your agent runs on, then sign in with your own subscription or an API key. You can add the other one later.',
    tip: () => 'You sign in with your own account. When you ask me for something, I work on it.',
  },
  {
    t: 'Meet your agent',
    d: 'A name and a character',
    title: 'Meet your agent',
    sub: 'It answers you in your chat and looks after your servers and connections. You can change its name and character later in Settings.',
    tip: () => 'Pick the one you like. I won’t be offended.',
  },
];

/**
 * “Set up your AI” without an AI signed in (first-day.md FDY-33): Continue waits for one, and skipping says what it
 * means rather than picking one for the person.
 */
export const AI_STEP_TEXT = {
  skip: 'Skip for now',
  later: 'If you skip this, your agent can’t answer until you sign in. You can do it later in Settings → AI.',
} as const;
