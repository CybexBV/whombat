/**
 * The person's prompts in the demo world (Whombat docs/decisions/prompts.md; app prompts-phone.md): Whombat's six
 * starters, “Find what’s broken” run on Fusebox three days ago and on the Whombat repository last week, and one of Mara's
 * own that isn't for a repository; T3 Code's projects to run them on. Keeping, changing, removing and bringing back
 * prompts change them in memory as the server does. Using one is answered by the fixture server, which posts the
 * message (`ran` records where it ran). Pure TypeScript over `Response`.
 */
import {
  PROMPT_RUNS_MAX,
  type Prompt,
  type PromptProject,
  type PromptProjectsResponse,
  type PromptsResponse,
  type SavePromptBody,
  STARTER_PROMPTS,
  starterPromptId,
  starterPromptOf,
} from '@whombat/core';

/** What T3 Code has open on Mara's computer. */
export const PROMPT_PROJECTS: PromptProject[] = [
  { id: 'proj-fusebox', title: 'Fusebox', folder: '~/Code/fusebox' },
  { id: 'proj-whombat', title: 'Whombat', folder: '~/Code/whombat' },
  { id: 'proj-garden', title: 'Garden planner', folder: '~/Code/garden-planner' },
  { id: 'proj-shop', title: 'Shop', folder: '~/Code/shop' },
];

const DAY = 86_400_000;

function starters(now: Date): Prompt[] {
  return STARTER_PROMPTS.map((s) => ({
    id: starterPromptId(s.key),
    title: s.title,
    text: s.text,
    onRepository: s.onRepository,
    ownIt: false,
    merge: false,
    ai: null,
    starter: true,
    edited: false,
    runs:
      s.key === 'audit'
        ? [
            {
              projectId: 'proj-fusebox',
              title: 'Fusebox',
              at: new Date(now.getTime() - 3 * DAY).toISOString(),
            },
            {
              projectId: 'proj-whombat',
              title: 'Whombat',
              at: new Date(now.getTime() - 8 * DAY).toISOString(),
            },
          ]
        : [],
    updatedAt: null,
  }));
}

function own(now: Date): Prompt {
  return {
    id: 'prm_weekly-note',
    title: 'Weekly note',
    text: 'Write a short note on what changed on my servers this week, in plain words, for the family group chat.',
    onRepository: false,
    ownIt: false,
    merge: false,
    ai: null,
    starter: false,
    edited: false,
    runs: [],
    updatedAt: new Date(now.getTime() - 10 * DAY).toISOString(),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const notFound = () => json({ error: { code: 'not_found', message: 'That prompt is gone.' } }, 404);

export interface PromptFixtureOptions {
  now: () => Date;
  /** How T3 Code is: `ready` with its projects, else none to choose from. */
  t3?: PromptProjectsResponse['t3'];
  /** A Whombat from before prompts: every prompt op answers `unknown_op`. */
  older?: boolean;
}

export interface PromptFixtures {
  handle(id: string | undefined, params: Record<string, string>, init?: RequestInit): Response | null;
  /** The prompt `prompts.use` names, or null. */
  get(id: string): Prompt | null;
  /** Records a run of the prompt on the project (the latest first). */
  ran(id: string, project: { id: string; title: string }): void;
}

export function createPromptFixtures(options: PromptFixtureOptions): PromptFixtures {
  const { now } = options;
  const t3 = options.t3 ?? 'ready';
  let prompts: Prompt[] = [...starters(now()), own(now())];
  let next = 1;
  const list = () => json({ prompts } satisfies PromptsResponse);
  const body = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as SavePromptBody;
  return {
    handle(id, params, init) {
      if (!id?.startsWith('prompts.')) return null;
      if (options.older) return json({ error: { code: 'unknown_op', message: id } }, 404);
      switch (id) {
        case 'prompts.list':
          return list();
        case 'prompts.projects':
          return json({
            projects: t3 === 'ready' ? PROMPT_PROJECTS : null,
            t3,
          } satisfies PromptProjectsResponse);
        case 'prompts.create': {
          const b = body(init);
          const prompt: Prompt = {
            id: `prm_new${next++}`,
            ...b,
            merge: b.merge ?? false,
            starter: false,
            edited: false,
            runs: [],
            updatedAt: now().toISOString(),
          };
          prompts = [...prompts, prompt];
          return json({ prompt }, 201);
        }
        case 'prompts.save': {
          const at = prompts.findIndex((p) => p.id === params.promptId);
          const was = prompts[at];
          if (!was) return notFound();
          const b = body(init);
          const shipped = starterPromptOf(was.id);
          const prompt: Prompt = {
            ...was,
            ...b,
            merge: b.merge ?? was.merge,
            edited: !!shipped && (b.title !== shipped.title || b.text !== shipped.text),
            updatedAt: now().toISOString(),
          };
          prompts = prompts.map((p, i) => (i === at ? prompt : p));
          return json({ prompt });
        }
        case 'prompts.remove':
          prompts = prompts.filter((p) => p.id !== params.promptId);
          return list();
        case 'prompts.restore': {
          const shipped = starters(now()).map((s) => {
            const kept = prompts.find((p) => p.id === s.id);
            return kept ? { ...s, runs: kept.runs, ownIt: kept.ownIt, ai: kept.ai } : { ...s, runs: [] };
          });
          prompts = [...shipped, ...prompts.filter((p) => !p.starter)];
          return list();
        }
        default:
          // `prompts.use` posts a message: the fixture server answers it.
          return null;
      }
    },
    get(id) {
      return prompts.find((p) => p.id === id) ?? null;
    },
    ran(id, project) {
      prompts = prompts.map((p) => {
        if (p.id !== id) return p;
        const at = now().toISOString();
        const runs = [
          { projectId: project.id, title: project.title, at },
          ...p.runs.filter((r) => r.projectId !== project.id),
        ];
        return { ...p, runs: runs.slice(0, PROMPT_RUNS_MAX) };
      });
    },
  };
}
