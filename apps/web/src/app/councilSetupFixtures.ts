/**
 * Mara's council in fixture mode (Settings → the assistant → Council; Whombat council.md): T3 Code's own council sits on
 * it (GPT 6.2 Sol, Claude Opus 5.5, Muse Wonder Full 1.0 and Gemini 4 Neon, all at Extra high), with Mara's rounds and
 * score, or none set (the usual ones); and what T3 Code runs now: Codex, Claude, Muse and Antigravity with their models
 * and efforts. Save and reset change the council in memory as the server does: the same rules (400 with the words), the
 * seats always T3 Code's, reset back to none. None set from the start: `VITE_FIXTURE_COUNCIL_SETUP=none` or
 * `localStorage['whombat:fixture-council-setup'] = 'none'`.
 */
import { councilSetupProblem } from '@whombat/client';
import type { CouncilProviderOption, CouncilSeatSetup, CouncilSetup } from '@whombat/core';
import type { CouncilSetupResponse, SaveCouncilSetupBody } from '@whombat/core/contracts';
import { burrow } from '@whombat/fixtures';

const B = `/api/v1/burrows/${burrow.slug}/councils/setup`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refused = (message: string) => json({ error: { code: 'validation_failed', message } }, 400);

/** What T3 Code runs, as its providers list them: the strongest model first. */
export const COUNCIL_PROVIDER_OPTIONS: CouncilProviderOption[] = [
  {
    id: 'codex',
    name: 'Codex',
    models: [
      {
        id: 'gpt-6.2-sol',
        label: 'GPT 6.2 Sol',
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
        fast: true,
      },
      {
        id: 'gpt-6.1-sol',
        label: 'GPT 6.1 Sol',
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
        fast: true,
      },
      { id: 'gpt-6.1', label: 'GPT 6.1', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'gpt-6.1-mini', label: 'GPT 6.1 Mini', efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
    ],
  },
  {
    id: 'claudeAgent',
    name: 'Claude',
    models: [
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'],
        defaultEffort: 'high',
        fast: false,
      },
      {
        id: 'claude-fable-5-1',
        label: 'Claude Fable 5.1',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        efforts: ['low', 'medium', 'high', 'max'],
        defaultEffort: 'medium',
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
      { id: 'muse-wonder', label: 'Muse Wonder', efforts: ['low', 'high'], defaultEffort: 'low' },
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

const seat = (provider: string, model: string, effort: string | null): CouncilSeatSetup => ({
  provider,
  model,
  effort,
});

/** Who T3 Code's council sits: the AIs its council skill names, each thinking hardest. */
const T3_COUNCIL: CouncilSeatSetup[] = [
  seat('codex', 'gpt-6.2-sol', 'xhigh'),
  seat('claudeAgent', 'claude-opus-5-5', 'xhigh'),
  seat('muse', 'muse-wonder-full-1.0', 'xhigh'),
  seat('antigravity', 'gemini-4-neon', 'xhigh'),
];

/** Mara's council: T3 Code's, up to 3 rounds and 9/10. */
function seeded(): CouncilSetup {
  return {
    seats: T3_COUNCIL,
    builder: 0,
    rounds: 3,
    target: 9,
    updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
  };
}

/** The browser's switch for a council none set (as `whombat:fixture-council`). */
export const COUNCIL_SETUP_FIXTURE_KEY = 'whombat:fixture-council-setup';

/** Whether Mara's council is set: the option, else not when the env or the browser's switch says `none`. */
function councilSetupSeeded(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  if (import.meta.env.VITE_FIXTURE_COUNCIL_SETUP === 'none') return false;
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(COUNCIL_SETUP_FIXTURE_KEY) !== 'none';
  } catch {
    return true;
  }
}

export interface CouncilSetupWorldOptions {
  /** Start with Mara's rounds and score (default) or with none set, the usual ones. */
  seeded?: boolean;
  /** What T3 Code says (default `ready`): not connected or unreachable answer no options. */
  t3?: CouncilSetupResponse['t3'];
}

export function createCouncilSetupFixtures(options: CouncilSetupWorldOptions = {}) {
  let setup: CouncilSetup | null = councilSetupSeeded(options.seeded) ? seeded() : null;
  const t3 = options.t3 ?? 'ready';

  // As the server: T3 Code's council sits on the person's too, with their rounds and score.
  const automatic = t3 === 'ready' ? T3_COUNCIL : [];
  const answer = (): CouncilSetupResponse => ({
    setup: setup && automatic.length >= 2 ? { ...setup, seats: automatic, builder: 0 } : setup,
    automatic,
    options: t3 === 'ready' ? COUNCIL_PROVIDER_OPTIONS : null,
    t3,
  });

  async function handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url, 'http://fixtures.local').pathname;
    if (path !== B && path !== `${B}/reset`) return null;
    if (req.method === 'GET' && path === B) return json(answer());
    if (req.method !== 'POST') return null;
    if (path === `${B}/reset`) {
      setup = null;
      return json({ setup: null });
    }
    const body = (await req.json()) as Partial<SaveCouncilSetupBody>;
    // The seats a client sends are kept as the server keeps them; T3 Code's council sits whatever they are.
    const draft = { seats: body.seats ?? [], builder: body.builder ?? 0 };
    const problem = councilSetupProblem(draft);
    if (problem) return refused(problem);
    setup = {
      seats: draft.seats,
      builder: draft.builder,
      rounds: body.rounds ?? 3,
      target: body.target ?? 9,
      updatedAt: new Date().toISOString(),
    };
    return json({ setup });
  }

  return { handle };
}
