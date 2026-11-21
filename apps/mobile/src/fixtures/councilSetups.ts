/**
 * Settings → Neo → Council in the demo world (Whombat docs/decisions/council.md; app council-phone.md): T3 Code's own
 * council (GPT 6.2 Sol, Claude Opus 5.5, Muse Wonder Full 1.0 and Gemini 4 Neon, all thinking extra hard) with Mara's
 * rounds and score, and what T3 Code runs (Codex, Claude, Muse, Antigravity). Save and “Use the usual rounds and score”
 * change it in memory as the server does: a council of one company is refused with the server's words, and whatever
 * seats are saved, T3 Code's council sits. Pure TypeScript over `Response`.
 */
import {
  type CouncilProviderOption,
  type CouncilSeatSetup,
  type CouncilSetup,
  type CouncilSetupResponse,
  councilSeatsProblem,
  type SaveCouncilSetupBody,
} from '@whombat/core';

/** What T3 Code runs on Mara's computer. */
export const COUNCIL_PROVIDER_OPTIONS: CouncilProviderOption[] = [
  {
    id: 'codex',
    name: 'Codex',
    models: [
      {
        id: 'gpt-6.2-sol',
        label: 'GPT 6.2 Sol',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
      },
      {
        id: 'gpt-6.1-sol',
        label: 'GPT 6.1 Sol',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
      },
      {
        id: 'gpt-6.1-mini',
        label: 'GPT 6.1 Mini',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    ],
  },
  {
    id: 'claudeAgent',
    name: 'Claude',
    models: [
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', efforts: [], defaultEffort: null },
    ],
  },
  {
    id: 'muse',
    name: 'Muse',
    models: [
      {
        id: 'muse-wonder-full-1.0',
        label: 'Muse Wonder Full 1.0',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
      },
      {
        id: 'muse-wonder-full',
        label: 'Muse Wonder Full',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
      },
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    models: [
      {
        id: 'gemini-4-neon',
        label: 'Gemini 4 Neon',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
      },
    ],
  },
];

/** Who T3 Code's council sits: the AIs its council skill names, each thinking hardest. */
export const COUNCIL_AUTOMATIC: CouncilSeatSetup[] = [
  { provider: 'codex', model: 'gpt-6.2-sol', effort: 'xhigh' },
  { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'xhigh' },
  { provider: 'muse', model: 'muse-wonder-full-1.0', effort: 'xhigh' },
  { provider: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' },
];

/** Mara's council: T3 Code's, up to 3 rounds and 9/10. */
function seededSetup(updatedAt: string): CouncilSetup {
  return { seats: COUNCIL_AUTOMATIC, builder: 0, rounds: 3, target: 9, updatedAt };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const refuse = (message: string) => json({ error: { code: 'validation_failed', message } }, 400);

export interface CouncilSetupFixtures {
  handle(id: string | undefined, init?: RequestInit): Response | null;
}

export interface CouncilSetupFixtureOptions {
  now: () => Date;
  /** How T3 Code is: `ready` with its choices, else none to choose from. */
  t3?: CouncilSetupResponse['t3'];
  /** Start with no rounds and score set (the usual ones). */
  empty?: boolean;
}

export function createCouncilSetupFixtures(options: CouncilSetupFixtureOptions): CouncilSetupFixtures {
  const { now } = options;
  const t3 = options.t3 ?? 'ready';
  let setup: CouncilSetup | null = options.empty
    ? null
    : seededSetup(new Date(now().getTime() - 3 * 86_400_000).toISOString());
  return {
    handle(id, init) {
      switch (id) {
        case 'councils.setup':
          // As the server: T3 Code's council sits on the person's too, with their rounds and score.
          return json({
            setup: setup ? { ...setup, seats: COUNCIL_AUTOMATIC, builder: 0 } : null,
            automatic: COUNCIL_AUTOMATIC,
            options: t3 === 'ready' ? COUNCIL_PROVIDER_OPTIONS : null,
            t3,
          } satisfies CouncilSetupResponse);
        case 'councils.saveSetup': {
          const body = JSON.parse(String(init?.body ?? '{}')) as SaveCouncilSetupBody;
          const problem = councilSeatsProblem(body.seats);
          if (problem) return refuse(problem);
          setup = {
            seats: body.seats,
            builder: Math.min(body.builder, body.seats.length - 1),
            rounds: body.rounds,
            target: body.target,
            updatedAt: now().toISOString(),
          };
          return json({ setup });
        }
        case 'councils.resetSetup':
          setup = null;
          return json({ setup: null });
        default:
          return null;
      }
    },
  };
}
