import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ps5PowerArtifact } from './ps5-power-artifact';

const body = Buffer.from('7f454c4601020304', 'hex');
const artifact = {
  url: 'https://raw.githubusercontent.com/owner/repo/commit/helper.elf',
  bytes: body.length,
  checksum: createHash('sha256').update(body).digest('hex'),
};
describe('pinned reboot helper download', () => {
  it('verifies all bytes before they can be uploaded', async () => {
    const requests: unknown[] = [];
    const result = await ps5PowerArtifact(
      {
        send: async (req, options) => {
          requests.push([req, options]);
          return { status: 200, headers: {}, body };
        },
      },
      artifact,
    );
    expect(result).toEqual(body);
    expect(requests).toEqual([[{ url: artifact.url, method: 'GET' }, { truncateAt: 256 * 1024 }]]);
  });
  it.each([
    { status: 302 },
    { truncated: true },
    { body: Buffer.from('changed') },
    { body: Buffer.concat([body, Buffer.from([0])]) },
    { body: Buffer.from('7f454c4601020305', 'hex') },
  ])('refuses an incomplete, redirected or modified artifact: %j', async (change) => {
    await expect(
      ps5PowerArtifact({ send: async () => ({ status: 200, headers: {}, body, ...change }) }, artifact),
    ).rejects.toThrow('Nothing was uploaded');
  });
});
