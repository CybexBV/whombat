/**
 * Onboarding state (`OB` steps in `Whombat Desktop.dc.html`), with one agent and one person: step 3 is “Meet your agent”,
 * where the person picks its name and face (Whombat one-agent.md OA-13); both start as Dusty.
 */
import type { OnboardingState } from '@whombat/core/domain';
import { DEFAULT_AGENT_FACE, DEFAULT_AGENT_NAME } from '@whombat/core/domain';

/**
 * `OB` in the mock: title/sub/tip copy for the three onboarding steps. Step 2 is “Set up your AI” instead of the mock's
 * “Connect your code” (SUB-08, CT-68); step 3 meets the one agent instead of picking a crew (OA-13); “Invite your team”
 * went in 3.0 (CT-1506).
 */
export const ONBOARDING_STEPS = [
  {
    t: 'Name your burrow',
    d: 'Give it a name',
    title: 'Name your burrow',
    sub: 'This is your Whombat’s name. It shows at the top of the sidebar.',
    tip: 'Hi, I’m Dusty. I’ll stick around in case you get stuck.',
  },
  {
    t: 'Set up your AI',
    d: 'Pick and sign in',
    title: 'Set up your AI',
    sub: 'Pick the AI Dusty runs on, then sign in with your own subscription or an API key. You can add the other one later.',
    tip: 'Dusty works on your own account, so nobody else’s usage is involved.',
  },
  {
    t: 'Meet your agent',
    d: 'Pick a name and a face',
    title: 'Meet your agent',
    sub: 'Give it a name and pick how it looks. It starts with a small set of keys, and you can hand over more once you trust it.',
    tip: 'Dusty is a fine name. You can change it later in Settings.',
  },
] as const;

/**
 * Burrow HQ's onboarding as the mock shows it (`S.burrow`): named. What `onboarding.get` returns when onboarding resumes
 * for burrow-hq. Three steps since 3.0 (CT-1506).
 */
export const onboarding: OnboardingState = {
  step: 0,
  burrowName: 'Burrow HQ',
  slug: 'burrow-hq',
  host: 'app.whombat.com/burrow-hq',
  agentName: DEFAULT_AGENT_NAME,
  agentFace: DEFAULT_AGENT_FACE,
  clients: [],
  provider: null,
  completedAt: null,
};
