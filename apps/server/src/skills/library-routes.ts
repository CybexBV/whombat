/**
 * Settings → Skills (contracts 3.0 CT-1570…CT-1572; hermes-skills.md HSK-02…HSK-12): the library, one skill and its
 * files, the person's edit (checked first by Hermes's scan, HSK-07), switch (Hermes's `skills.disabled`, HSK-05),
 * remove (a hub skill uninstalled the Hermes way) and restore (Hermes's reset of a built-in). One skill per name. Each
 * change answers the row as it is now; the audit log signs what changed (`skill.changed`, `skill.switched`,
 * `skill.removed`, `skill.reset`). Hermes's hub is `hub-routes.ts`.
 */
import { api } from '@whombat/core';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import { recordSkillChange } from './commands';
import { refuseUnlessAllowed, skillsCall } from './hermes';
import { findSkill, itemNow, libraryView, viewerOf } from './library';
import { bodyOf, originalOf, withBody } from './text';

/** A file of a skill as text (`bad_request` for one that isn't). */
function asText(data: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(data, 'base64'));
  } catch {
    throw badRequest('That file isn’t text.');
  }
}

export const libraryRoutes: RouteDef[] = [
  route(api.skills.library, async ({ services, access }) =>
    libraryView(services, viewerOf(access.principal)),
  ),

  route(api.skills.librarySkill, async ({ services, access, query }) => {
    const viewer = viewerOf(access.principal);
    const s = await findSkill(services, query.name);
    const read = await skillsCall(services, 'skills.read', { path: s.path });
    const item = await itemNow(services, viewer, query.name);
    if (!item) throw notFound('Skill');
    return {
      item,
      text: bodyOf(read.text),
      files: read.files.map((f) => ({ path: f.path, bytes: f.bytes })),
      original: originalOf(read),
    };
  }),

  route(api.skills.librarySkillFile, async ({ services, query }) => {
    const s = await findSkill(services, query.name);
    const file = await skillsCall(services, 'skills.readFile', { path: s.path, file: query.path });
    return { path: query.path, text: asText(file.data) };
  }),

  // The person's edit of a skill: its text, checked by Hermes's scan as an agent's would be (HSK-07).
  route(api.skills.libraryEdit, async (ctx) => {
    const { services, access, body } = ctx;
    const viewer = viewerOf(access.principal);
    if (!viewer.isPerson) throw forbidden('Only you change a skill.');
    const s = await findSkill(services, body.name);
    if (s.state === 'removed') throw notFound('Skill');
    const ref = { path: s.path };
    const read = await skillsCall(services, 'skills.read', ref);
    const text = withBody(read.text, body.name, body.body, body.description);
    refuseUnlessAllowed(
      await skillsCall(services, 'skills.scan', { ...ref, text }),
      'Hermes found something dangerous in this change, so it can’t be saved.',
    );
    await skillsCall(services, 'skills.write', {
      ...ref,
      text,
      ...(body.ifVersion ? { ifVersion: body.ifVersion } : {}),
      by: access.principal.accountId ?? null,
    });
    await commitAs(ctx, recordSkillChange, {
      type: 'skill.changed',
      name: body.name,
      text: `Changed the skill ${body.name}`,
    });
    return { item: await itemNow(services, viewer, body.name) };
  }),

  route(api.skills.librarySwitch, async (ctx) => {
    const { services, access, body } = ctx;
    const viewer = viewerOf(access.principal);
    if (!viewer.isPerson) throw forbidden('Only you switch a skill.');
    const s = await findSkill(services, body.name);
    await skillsCall(services, 'skills.setOff', {
      path: s.path,
      off: !body.on,
      by: access.principal.accountId ?? null,
    });
    await commitAs(ctx, recordSkillChange, {
      type: 'skill.switched',
      name: body.name,
      text: `Switched the skill ${body.name} ${body.on ? 'on' : 'off'}`,
    });
    return { item: await itemNow(services, viewer, body.name) };
  }),

  route(api.skills.libraryRemove, async (ctx) => {
    const { services, access, body } = ctx;
    const viewer = viewerOf(access.principal);
    if (!viewer.isPerson) throw forbidden('Only you remove a skill.');
    const s = await findSkill(services, body.name);
    const by = access.principal.accountId ?? null;
    // A hub skill goes the Hermes way: its folder and its entry in Hermes's hub lock together.
    if (s.origin === 'hub') await skillsCall(services, 'skills.hubUninstall', { path: s.path, by });
    else await skillsCall(services, 'skills.remove', { path: s.path, by });
    await commitAs(ctx, recordSkillChange, {
      type: 'skill.removed',
      name: body.name,
      text: `Removed the skill ${body.name}`,
    });
    return { item: await itemNow(services, viewer, body.name) };
  }),

  route(api.skills.libraryRestore, async (ctx) => {
    const { services, access, body } = ctx;
    const viewer = viewerOf(access.principal);
    if (!viewer.isPerson) throw forbidden('Only you restore a skill.');
    const s = await findSkill(services, body.name);
    if (s.origin !== 'builtin') throw badRequest('Only one of Hermes’s own skills can be restored.');
    await skillsCall(services, 'skills.restore', { path: s.path, by: access.principal.accountId ?? null });
    await commitAs(ctx, recordSkillChange, {
      type: 'skill.reset',
      name: body.name,
      text: `Restored the skill ${body.name} as Hermes ships it`,
    });
    return { item: await itemNow(services, viewer, body.name) };
  }),
];
