/**
 * Whombat's two device tools (docs/decisions/one-whombat.md ONE-16, ONE-17; contracts 0.80 CT-340):
 *
 * - `device_probe` reads a device with the built-in drivers, read-only (it has no way to write): the readings the agent
 *   took from the manual, each with its value, the raw words and why one failed. The address must be on the local network
 *   (ONE-DD03).
 * - `propose_device_skill` checks the profile, reads every reading and every action's current value once more (the
 *   test the card shows: “Tested on your unit”), and posts the `device_skill` card. A profile that doesn't read cleanly
 *   is refused with what to fix, so the person never sees a card that half works (ONE-19).
 *
 * Both are the agent's (`personal: true`) and need its “connected services” read key at Allowed, as any
 * connection read does (CX-20).
 */
import type { McpToolOutput } from '@whombat/core';
import { keyTierOf } from '../connections/context';
import { ApiError, forbidden } from '../lib/errors';
import type { ToolHandler } from '../mcp/tools';
import { loadGrants, loadPrincipalRow } from '../read/principals';
import { DeviceCallError, type ReadingResult, readDevice } from './driver';
import { deviceProfileProblems } from './profile';
import { proposeDeviceSkill } from './skills';
import { type DeviceAddress, type DeviceProfile, MODBUS_DEFAULT_PORT, MODBUS_DEFAULT_UNIT_ID } from './types';

function defaultPort(driver: DeviceProfile['driver']): number {
  return driver === 'modbus_tcp' ? MODBUS_DEFAULT_PORT : 80;
}

async function requireAssistant(ctx: Parameters<ToolHandler<'device_probe'>>[0]): Promise<void> {
  const agent = await loadPrincipalRow(ctx.services.db, ctx.agentId);
  if (agent?.kind !== 'agent') throw forbidden('Only the agent reads devices.');
  if (keyTierOf(ctx.agentId, await loadGrants(ctx.services.db, ctx.agentId), 'connections.read') !== 'can')
    throw forbidden(
      'Reading devices needs your “Read connected services” key at Allowed. Ask the person for it.',
    );
}

function deviceError(err: unknown): never {
  if (err instanceof DeviceCallError) throw new ApiError('conflict', err.message);
  throw err;
}

function probeValue(r: ReadingResult) {
  return {
    key: r.key,
    label: r.label,
    value: r.value,
    ...(r.unit ? { unit: r.unit } : {}),
    ...(r.raw !== undefined ? { raw: r.raw } : {}),
    ...(r.error ? { error: r.error.slice(0, 200) } : {}),
  };
}

export const deviceProbeTool: ToolHandler<'device_probe'> = async (ctx, input) => {
  await requireAssistant(ctx);
  const address: DeviceAddress = {
    host: input.host,
    port: input.port ?? defaultPort(input.driver),
    ...(input.driver === 'modbus_tcp' ? { unitId: input.unitId ?? MODBUS_DEFAULT_UNIT_ID } : {}),
  };
  const problems = deviceProfileProblems({
    name: 'probe',
    driver: input.driver,
    defaults: {},
    readings: input.readings,
    actions: [],
    source: {},
  });
  if (problems.length)
    throw new ApiError('validation_failed', problems[0] as string, {
      fields: { readings: problems },
    });
  const readings = await readDevice(
    ctx.services,
    { driver: input.driver, readings: input.readings },
    address,
  ).catch(deviceError);
  ctx.services.log.info(
    {
      agentId: ctx.agentId,
      driver: input.driver,
      readings: readings.length,
      failed: readings.filter((r) => r.error).length,
    },
    'devices: probed a device',
  );
  return {
    status: 'ok',
    readings: readings.map(probeValue),
    at: ctx.services.clock().toISOString(),
  } satisfies McpToolOutput<'device_probe'>;
};

export const proposeDeviceSkillTool: ToolHandler<'propose_device_skill'> = async (ctx, input) => {
  await requireAssistant(ctx);
  if (ctx.dispatch.search)
    throw forbidden('Propose a device skill from a chat, not while answering a search.');
  const profile = input.profile;
  const problems = deviceProfileProblems(profile);
  if (problems.length)
    throw new ApiError('validation_failed', 'The profile needs a few fixes first.', {
      fields: { profile: problems },
    });
  const port = input.port ?? profile.defaults.port ?? defaultPort(profile.driver);
  const unitId =
    profile.driver === 'modbus_tcp'
      ? (input.unitId ?? profile.defaults.unitId ?? MODBUS_DEFAULT_UNIT_ID)
      : null;
  const address: DeviceAddress = {
    host: input.host,
    port,
    ...(unitId !== null ? { unitId } : {}),
    ...(profile.defaults.basePath ? { basePath: profile.defaults.basePath } : {}),
  };
  // The test the card shows: every reading, and each action's current value where the device can say it.
  const actionReads =
    profile.driver === 'modbus_tcp'
      ? profile.actions
          .filter((a) => a.modbus && !profile.readings.some((r) => r.key === a.key))
          .map((a) => ({ key: `action:${a.key}`, label: a.label, modbus: a.modbus }))
      : [];
  const read = await readDevice(
    ctx.services,
    { driver: profile.driver, readings: [...profile.readings, ...actionReads], actions: profile.actions },
    address,
  ).catch(deviceError);
  const failed = read.filter((r) => r.error);
  if (failed.length)
    throw new ApiError(
      'validation_failed',
      'Some values didn’t read on the unit; fix them before proposing.',
      {
        fields: {
          profile: failed
            .slice(0, 10)
            .map((r) =>
              r.key.startsWith('action:')
                ? `Action “${r.key.slice(7)}”: reading its current value didn’t work (${r.error}).`
                : `Reading “${r.key}”: ${r.error}`,
            ),
        },
      },
    );
  const tested = read.filter((r) => !r.key.startsWith('action:'));
  const res = await ctx.services.pipeline.commit(
    proposeDeviceSkill,
    {
      profile,
      host: input.host,
      port,
      unitId,
      tested,
      testedAt: ctx.services.clock().toISOString(),
      conversationId: ctx.dispatch.conversationId,
      threadRootId: ctx.dispatch.threadRootId ?? null,
      dispatchId: ctx.dispatch.id,
      personId: ctx.onBehalfOf.principalId ?? null,
    },
    { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
  );
  if (res.status === 'ok') return { status: 'ok', proposalId: res.result.proposalId };
  if (res.status === 'pending_approval')
    return {
      status: 'pending_approval',
      approvalId: res.approvalId,
      approvalNumber: res.approvalNumber,
      eventId: res.eventId,
      message: res.message,
    };
  return { status: 'blocked', keyNeeded: res.keyNeeded, eventId: res.eventId, message: res.message };
};
