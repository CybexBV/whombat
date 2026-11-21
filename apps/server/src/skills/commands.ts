/**
 * The audit records of Settings → Skills (hermes-engine.md HE-41; hermes-skills.md HSK-06, HSK-09): the person's change
 * to a skill — `skill.changed`, `skill.switched`, `skill.removed`, `skill.reset` — by name, and a skill installed or
 * updated from Hermes's hub — `skill.installed`, `skill.updated` — with where it came from and what Hermes's scan said
 * (CT-1416).
 */
import { ScanVerdict, SkillHubIdentifier, SkillHubSource, SkillTrust } from '@whombat/core';
import { z } from 'zod';
import { defineCommand } from '../commit/types';

const SkillChange = z.object({
  type: z.enum(['skill.changed', 'skill.switched', 'skill.removed', 'skill.reset']),
  name: z.string().max(64),
  text: z.string().max(300),
});

/** The record of the person's change to a skill. Names only. */
export const recordSkillChange = defineCommand({
  name: 'record_skill_change',
  schema: SkillChange,
  async apply(_tx, ctx, input) {
    await ctx.emit({
      type: input.type,
      kind: 'Keys',
      text: input.text,
      where: 'Settings · Skills',
      payload: { name: input.name },
    });
    return {};
  },
});

const SkillInstall = z.object({
  type: z.enum(['skill.installed', 'skill.updated']),
  name: z.string().max(64),
  source: SkillHubSource,
  identifier: SkillHubIdentifier,
  trust: SkillTrust,
  verdict: ScanVerdict,
});

/** The record of a hub skill the person installed or updated (CT-1416). */
export const recordSkillInstall = defineCommand({
  name: 'record_skill_install',
  schema: SkillInstall,
  async apply(_tx, ctx, input) {
    const { type, ...payload } = input;
    await ctx.emit({
      type,
      kind: 'Keys',
      text:
        type === 'skill.installed' ? `Installed the skill ${input.name}` : `Updated the skill ${input.name}`,
      where: 'Settings · Skills',
      payload,
    });
    return {};
  },
});
