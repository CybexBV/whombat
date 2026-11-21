/**
 * `api.skills.*` for `createFixtureFetch()` (contracts 0.125, CT-1210…CT-1216; since 2.0 with Hermes's hub, CT-1433;
 * since 3.0 one list, CT-1582): Settings → Skills on the mock world's skills (`skills.ts`), with Mara's changes applied
 * to an in-memory copy.
 */
import {
  ERROR_STATUS,
  type LibrarySkillResponse,
  SkillEditBody,
  SkillHubIdentifierQuery,
  SkillHubInstallBody,
  SkillHubSearchQuery,
  SkillHubUpdateBody,
  type SkillLibraryItem,
  SkillRefQuery,
  SkillRemoveBody,
  SkillRestoreBody,
  SkillSwitchBody,
} from '@whombat/core/contracts';
import { skillBody } from '@whombat/core/skills';
import { dusty } from './principals.js';
import {
  FIXTURE_HUB_RESULTS,
  FIXTURE_SKILL_CATEGORIES,
  FIXTURE_SKILLS,
  type FixtureSkill,
  fixtureHubPreview,
  skillCan,
} from './skills.js';
import { SEED_NOW } from './time.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function error(
  code: keyof typeof ERROR_STATUS,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, ERROR_STATUS[code]);
}

/** The fixture world's skills, by name. */
export function createSkillsWorld() {
  return new Map<string, FixtureSkill>(FIXTURE_SKILLS.map((s) => [s.item.name, structuredClone(s)]));
}

export type SkillsWorld = ReturnType<typeof createSkillsWorld>;

function detail(s: FixtureSkill): LibrarySkillResponse {
  return {
    item: s.item,
    text: skillBody(s.text),
    files: s.files.map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.text).length })),
    original: s.original
      ? {
          text: skillBody(s.original),
          changes: s.original === s.text ? [] : [{ path: 'SKILL.md', status: 'modified' }],
        }
      : null,
  };
}

/** Answers a `skills.*` endpoint, or null when `id` is not one this fixture serves. */
export async function handleSkills(
  world: SkillsWorld,
  id: string,
  _params: Record<string, string>,
  url: URL,
  req: Request,
): Promise<Response | null> {
  if (!(SKILLS_ENDPOINT_IDS as readonly string[]).includes(id)) return null;
  const now = SEED_NOW.toISOString();
  const query = () => SkillRefQuery.safeParse(Object.fromEntries(url.searchParams));
  const save = (s: FixtureSkill, changes: Partial<SkillLibraryItem>) => {
    const item = { ...s.item, ...changes, updatedAt: now };
    const next = { ...s, item: { ...item, can: skillCan(item) } };
    world.set(item.name, next);
    return next;
  };
  const installedIds = () =>
    new Set([...world.values()].flatMap((s) => (s.item.hub ? [s.item.hub.identifier] : [])));
  const withInstalled = (r: (typeof FIXTURE_HUB_RESULTS)[number]) => ({
    ...r,
    installed: installedIds().has(r.identifier),
  });

  switch (id) {
    case 'skills.library':
      return json({
        agentName: dusty.name,
        items: [...world.values()].map((s) => s.item).sort((a, b) => a.name.localeCompare(b.name)),
        categories: FIXTURE_SKILL_CATEGORIES,
      });
    case 'skills.librarySkill': {
      const q = query();
      const s = q.success ? world.get(q.data.name) : undefined;
      return s ? json(detail(s)) : error('not_found', 'No such skill.');
    }
    case 'skills.librarySkillFile': {
      const q = query();
      const path = url.searchParams.get('path');
      const s = q.success ? world.get(q.data.name) : undefined;
      const file = s?.files.find((f) => f.path === path);
      return file ? json({ path: file.path, text: file.text }) : error('not_found', 'No such file.');
    }
    case 'skills.libraryEdit': {
      const parsed = SkillEditBody.safeParse(await req.json());
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const s = world.get(parsed.data.name);
      if (!s || s.item.status === 'removed') return error('not_found', 'No such skill.');
      if (parsed.data.ifVersion !== undefined && parsed.data.ifVersion !== s.item.version)
        return error('conflict', 'It changed since you opened it.');
      const builtin = s.item.origin === 'builtin';
      const front = s.text.slice(0, s.text.length - skillBody(s.text).length);
      const next = save(
        { ...s, text: `${front}${parsed.data.body}`, original: builtin ? (s.original ?? s.text) : null },
        {
          changed: builtin,
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
        },
      );
      return json({ item: next.item });
    }
    case 'skills.librarySwitch': {
      const parsed = SkillSwitchBody.safeParse(await req.json());
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const s = world.get(parsed.data.name);
      if (!s || s.item.status === 'removed') return error('not_found', 'No such skill.');
      const next = save(s, { enabled: parsed.data.on, status: parsed.data.on ? 'on' : 'off' });
      return json({ item: next.item });
    }
    case 'skills.libraryRemove': {
      const parsed = SkillRemoveBody.safeParse(await req.json());
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const s = world.get(parsed.data.name);
      if (!s || s.item.status === 'removed') return error('not_found', 'No such skill.');
      if (s.item.origin === 'builtin') {
        const next = save(
          { ...s, original: s.original ?? s.text },
          { status: 'removed', enabled: false, changed: false, originalChanged: false },
        );
        return json({ item: next.item });
      }
      world.delete(parsed.data.name);
      return json({ item: null });
    }
    case 'skills.libraryRestore': {
      const parsed = SkillRestoreBody.safeParse(await req.json());
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const s = world.get(parsed.data.name);
      if (s?.item.origin !== 'builtin' || !(s.item.changed || s.item.status === 'removed'))
        return error('conflict', 'There’s nothing to restore.');
      const next = save(
        { ...s, text: s.original ?? s.text, original: null },
        { changed: false, originalChanged: false, status: 'on', enabled: true },
      );
      return json({ item: next.item });
    }
    case 'skills.hubSearch': {
      const parsed = SkillHubSearchQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const q = (parsed.data.q ?? '').toLowerCase();
      const results = FIXTURE_HUB_RESULTS.filter(
        (r) =>
          (!parsed.data.source || r.source === parsed.data.source) &&
          (!q || `${r.name} ${r.description}`.toLowerCase().includes(q)),
      ).map(withInstalled);
      return json({ results, unreachable: [] });
    }
    case 'skills.hubPreview': {
      const parsed = SkillHubIdentifierQuery.safeParse(Object.fromEntries(url.searchParams));
      const found = parsed.success
        ? FIXTURE_HUB_RESULTS.find((r) => r.identifier === parsed.data.identifier)
        : undefined;
      if (!found) return error('not_found', 'The hub doesn’t have that skill.');
      const result = withInstalled(found);
      return json(fixtureHubPreview(result, !result.installed && world.has(result.name)));
    }
    case 'skills.hubInstall': {
      const parsed = SkillHubInstallBody.safeParse(await req.json());
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const found = FIXTURE_HUB_RESULTS.find((r) => r.identifier === parsed.data.identifier);
      if (!found) return error('not_found', 'The hub doesn’t have that skill.');
      if (installedIds().has(found.identifier) || world.has(found.name))
        return error('conflict', 'There’s already a skill with that name.', {
          code: 'skill_exists',
        });
      const preview = fixtureHubPreview(found, false);
      if (preview.policy.decision === 'block')
        return error('not_allowed', preview.policy.reason, {
          code: 'skill_blocked',
          verdict: preview.scan.verdict,
          trust: found.trust,
        });
      const category = found.identifier.split('/').slice(1, -1)[0] ?? null;
      const base: Omit<SkillLibraryItem, 'can'> = {
        name: found.name,
        description: found.description,
        category: found.source === 'official' ? category : null,
        origin: 'hub',
        hub: {
          source: found.source,
          identifier: found.identifier,
          trust: found.trust,
          updateAvailable: false,
        },
        enabled: true,
        changed: false,
        originalChanged: false,
        status: 'on',
        needs: preview.needs,
        version: '4e5f60718293a4b5',
        updatedAt: now,
      };
      const installed = save(
        { item: { ...base, can: skillCan(base) }, text: preview.text, files: [], original: null },
        {},
      );
      return json({ item: installed.item }, 201);
    }
    case 'skills.hubUpdates': {
      const available = [...world.values()]
        .filter((s) => s.item.hub?.updateAvailable)
        .map((s) => s.item.name)
        .sort();
      return json({ checkedAt: now, available, unreachable: [] });
    }
    case 'skills.hubUpdate': {
      const parsed = SkillHubUpdateBody.safeParse(await req.json());
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const s = world.get(parsed.data.name);
      if (!s?.item.hub) return error('not_found', 'No such hub skill.');
      if (!s.item.hub.updateAvailable) return error('conflict', 'It’s up to date.');
      const next = save(s, { hub: { ...s.item.hub, updateAvailable: false }, version: 'c3d4e5f60718293a' });
      return json({ item: next.item });
    }
    default:
      return null;
  }
}

/** Every skills endpoint the fixture fetch serves. */
export const SKILLS_ENDPOINT_IDS = [
  'skills.library',
  'skills.librarySkill',
  'skills.librarySkillFile',
  'skills.libraryEdit',
  'skills.librarySwitch',
  'skills.libraryRemove',
  'skills.libraryRestore',
  'skills.hubSearch',
  'skills.hubPreview',
  'skills.hubInstall',
  'skills.hubUpdates',
  'skills.hubUpdate',
] as const;
