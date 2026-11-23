/**
 * The apps parse an op's input with its endpoint's schemas before they send it over the session, and the box parses
 * what arrives with the same schemas again. A field that turns its input into something else (`?dark=true` into
 * `true`) must take its own result too, or the box refuses every such request as not valid.
 */
import { api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { API_OPERATIONS, apiOperationInput } from './operations.js';

type Schema = z.ZodType & { _zod: { def: Record<string, unknown> & { type: string } } };

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'catch', 'readonly']);

/** The enum options a field turns into something else (through a transform), wherever it sits in a union. */
function transformedOptions(s: Schema): string[] {
  const d = s._zod.def;
  if (WRAPPERS.has(d.type)) return transformedOptions(d.innerType as Schema);
  if (d.type === 'union') return (d.options as Schema[]).flatMap(transformedOptions);
  if (d.type !== 'pipe') return [];
  const from = (d.in as Schema)._zod.def;
  const to = (d.out as Schema)._zod.def;
  if (to.type !== 'transform' || from.type !== 'enum') return [];
  return Object.values(from.entries as Record<string, string>);
}

function fields(s: unknown): [string, Schema][] {
  const shape = (s as Schema | undefined)?._zod.def.shape as Record<string, Schema> | undefined;
  return shape ? Object.entries(shape) : [];
}

describe('an op’s input over the session', () => {
  it('takes what the app’s own parse made of it, for every field that transforms', () => {
    const refused: string[] = [];
    let checked = 0;
    for (const spec of API_OPERATIONS.values()) {
      const ep = spec.endpoint;
      if (!ep) continue;
      for (const part of ['params', 'query', 'body'] as const)
        for (const [name, field] of fields(ep[part]))
          for (const option of transformedOptions(field)) {
            checked++;
            const sent = JSON.parse(JSON.stringify({ v: field.parse(option) })).v;
            if (!field.safeParse(sent).success) refused.push(`${spec.op} ${part}.${name} = ${option}`);
          }
    }
    expect(checked).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  });

  it('draws the Find My map in either theme', () => {
    const ep = api.hosts.findMyMap;
    for (const dark of ['true', 'false'] as const) {
      const query = ep.query.parse({ w: 384, h: 256, dark });
      const wire = JSON.parse(JSON.stringify({ params: { burrow: 'home', serverId: 'studio' }, query }));
      const box = apiOperationInput(ep).parse(wire);
      expect(box.query).toMatchObject({ w: 384, h: 256, dark: dark === 'true' });
    }
  });

  it('lists the archived task chats', () => {
    const ep = api.chats.list;
    const query = ep.query.parse({ archived: 'true' });
    const wire = JSON.parse(JSON.stringify({ params: { burrow: 'home' }, query }));
    expect(apiOperationInput(ep).parse(wire).query).toMatchObject({ archived: true });
  });

  it('still reads the words of an address', () => {
    expect(api.hosts.findMyMap.query.parse({ w: '384', h: '256', dark: '1' })).toMatchObject({ dark: true });
    expect(api.chats.list.query.parse({ archived: '0' })).toMatchObject({ archived: false });
    expect(api.chats.list.query.safeParse({ archived: 'yes' }).success).toBe(false);
  });
});
