import { createHash } from 'node:crypto';
import { PS5_POWER_HELPER } from '@whombat/core';
import type { AdapterContext } from './adapters/types';
import { ConnectionArgumentError } from './request';

/** Fetch only a pinned artifact; no redirects or caller-supplied download tool. PS5 connections have no credential. */
export async function ps5PowerArtifact(
  ctx: Pick<AdapterContext, 'send'>,
  artifact: { url: string; checksum: string; bytes: number } = PS5_POWER_HELPER,
): Promise<Buffer> {
  const res = await ctx.send({ url: artifact.url, method: 'GET' }, { truncateAt: 256 * 1024 });
  if (
    res.status !== 200 ||
    res.truncated ||
    res.body.length !== artifact.bytes ||
    res.body.subarray(0, 4).toString('hex') !== '7f454c46' ||
    createHash('sha256').update(res.body).digest('hex') !== artifact.checksum
  )
    throw new ConnectionArgumentError(
      'The reboot helper didn’t match its checked release. Nothing was uploaded or run.',
    );
  return res.body;
}
