/**
 * The person's prompts in fixture mode (Whombat docs/decisions/prompts.md): the ones Whombat ships, “Find what’s broken”
 * having run on Fusebox three days ago, T3 Code's projects, and keeping, changing, removing and bringing back prompts in
 * memory as the server does. Using one posts “<title> · <project>” in Chat through the fixture world's own send, so it
 * shows as a sent message does. `t3` says how T3 Code answers (`VITE_FIXTURE_PROMPTS_T3`); `available: false` is a box
 * from before (`unknown_op`). The AI menu's `delegations.models` is answered here when no other layer does.
 */
import {
  newId,
  type Prompt,
  promptLine,
  STARTER_PROMPTS,
  starterPromptId,
  starterPromptOf,
} from '@whombat/core';
import type {
  PromptProject,
  PromptProjectsResponse,
  SavePromptBody,
  UsePromptBody,
} from '@whombat/core/contracts';
import { burrow } from '@whombat/fixtures';
import { COUNCIL_PROVIDER_OPTIONS } from './councilSetupFixtures';

const B = `/api/v1/burrows/${burrow.slug}`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface PromptWorldOptions {
  /** The box knows the prompts (default true); false: it answers `unknown_op`. */
  available?: boolean;
  /** How T3 Code answers for its projects (default `ready`). */
  t3?: PromptProjectsResponse['t3'];
}

export const PROMPT_FIXTURE_PROJECTS: PromptProject[] = [
  { id: 'prj_fusebox', title: 'Fusebox', folder: '~/Code/fusebox' },
  { id: 'prj_whombat', title: 'Whombat', folder: '~/Code/Whombat' },
  { id: 'prj_tracker', title: 'Acme Desk', folder: '~/Code/tracker' },
  { id: 'prj_website', title: 'Website', folder: '~/Code/website' },
];

function starters(): Prompt[] {
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
    runs: [],
    updatedAt: null,
  }));
}

function t3Of(value: string | undefined): PromptProjectsResponse['t3'] | undefined {
  return value === 'ready' || value === 'not_connected' || value === 'unreachable' ? value : undefined;
}

export function createPromptFixtures(options: PromptWorldOptions = {}) {
  const available = options.available ?? true;
  const t3 = options.t3 ?? t3Of(import.meta.env.VITE_FIXTURE_PROMPTS_T3) ?? 'ready';
  let prompts = starters();
  const first = prompts[0];
  if (first) {
    first.runs = [
      {
        projectId: 'prj_fusebox',
        title: 'Fusebox',
        at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      },
    ];
  }
  prompts.push({
    id: 'prm_fixtureweekly',
    title: 'Weekly summary',
    text: 'Write a short summary of what changed this week, in plain words, for people who don’t read code.',
    onRepository: false,
    ownIt: false,
    merge: false,
    ai: null,
    starter: false,
    edited: false,
    runs: [],
    updatedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
  });

  async function body<T>(req: Request): Promise<T> {
    const text = await req.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  const list = () => json({ prompts });

  async function handle(req: Request, inner: (req: Request) => Promise<Response>): Promise<Response | null> {
    const path = new URL(req.url, 'http://fixtures.local').pathname;
    if (path === `${B}/delegations/models` && req.method === 'GET') {
      const res = await inner(req.clone());
      if (res.ok) return res;
      return json({ options: COUNCIL_PROVIDER_OPTIONS, t3 });
    }
    if (!path.startsWith(`${B}/prompts`)) return null;
    if (!available) return json({ error: { code: 'unknown_op', message: 'No operation prompts' } }, 404);
    const rest = path.slice(`${B}/prompts`.length);
    const route = `${req.method} ${rest}`;
    if (route === 'GET ') return list();
    if (route === 'GET /projects')
      return json({ projects: t3 === 'ready' ? PROMPT_FIXTURE_PROJECTS : null, t3 });
    if (route === 'POST /restore') {
      const own = prompts.filter((p) => !p.starter);
      const kept = new Map(prompts.filter((p) => p.starter).map((p) => [p.id, p]));
      prompts = [
        ...starters().map((s) => ({
          ...s,
          runs: kept.get(s.id)?.runs ?? [],
          ai: kept.get(s.id)?.ai ?? null,
        })),
        ...own,
      ];
      return list();
    }
    if (route === 'POST ') {
      const b = await body<SavePromptBody>(req);
      const made: Prompt = {
        id: newId('prompt'),
        title: b.title.trim(),
        text: b.text.trim(),
        onRepository: b.onRepository,
        ownIt: b.ownIt,
        merge: b.merge ?? false,
        ai: b.ai,
        starter: false,
        edited: false,
        runs: [],
        updatedAt: new Date().toISOString(),
      };
      prompts = [...prompts, made];
      return json({ prompt: made }, 201);
    }
    const use = /^\/([^/]+)\/use$/.exec(rest);
    if (use && req.method === 'POST') {
      const prompt = prompts.find((p) => p.id === decodeURIComponent(use[1] as string));
      if (!prompt) return json({ error: { code: 'not_found', message: 'That prompt is gone.' } }, 404);
      const b = await body<UsePromptBody>(req);
      // Through the world's own send, so Chat shows the message as it shows one typed.
      const sent = await inner(
        new Request(new URL(`${B}/conversations/${b.conversationId}/messages`, req.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: promptLine(prompt.title, b.project.title),
            ...(b.rootId ? { threadRootId: b.rootId } : {}),
          }),
        }),
      );
      if (!sent.ok) return sent;
      const { message } = (await sent.json()) as { message: { id: string; threadRootId: string | null } };
      const at = new Date().toISOString();
      prompt.runs = [
        { projectId: b.project.id, title: b.project.title, at },
        ...prompt.runs.filter((r) => r.projectId !== b.project.id),
      ].slice(0, 12);
      return json({ messageId: message.id, rootId: message.threadRootId ?? message.id }, 201);
    }
    const one = /^\/([^/]+)$/.exec(rest);
    if (one) {
      const id = decodeURIComponent(one[1] as string);
      const at = prompts.findIndex((p) => p.id === id);
      if (at < 0) return json({ error: { code: 'not_found', message: 'That prompt is gone.' } }, 404);
      if (req.method === 'DELETE') {
        prompts = prompts.filter((p) => p.id !== id);
        return list();
      }
      if (req.method === 'PUT') {
        const b = await body<SavePromptBody>(req);
        const was = prompts[at] as Prompt;
        const shipped = starterPromptOf(id);
        const next: Prompt = {
          ...was,
          title: b.title.trim(),
          text: b.text.trim(),
          onRepository: b.onRepository,
          ownIt: b.ownIt,
          merge: b.merge ?? was.merge,
          ai: b.ai,
          edited: !!shipped && (shipped.title !== b.title.trim() || shipped.text !== b.text.trim()),
          updatedAt: new Date().toISOString(),
        };
        prompts = prompts.map((p) => (p.id === id ? next : p));
        return json({ prompt: next });
      }
    }
    return null;
  }

  return { handle };
}
