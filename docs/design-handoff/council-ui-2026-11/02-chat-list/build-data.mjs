// Fixture snapshots for static design studies. Does not start or change an app.
// From the repo root: node --import tsx docs/design-handoff/council-ui-2026-11/02-chat-list/build-data.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentWords } from '../../../../packages/client/src/agentName.ts';

// These Vite fixture factories read import.meta.env. Compile only for this read,
// with every optional environment switch off; the working copy stays untouched.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
await mkdir('.whombat', { recursive: true });
const outfile = resolve('.whombat/chat-list-fixtures.mjs');
await build({ stdin: { contents: `export { createChatChannelFixtures } from './apps/web/src/app/chatChannelFixtures.ts'; export { createLookFixtures } from './apps/web/src/app/lookFixtures.ts'; export { ASSISTANT_NAME } from './apps/web/src/app/oneFixtures.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', define: { 'import.meta.env': '{}' }, outfile });
const { createChatChannelFixtures, createLookFixtures, ASSISTANT_NAME } = await import(pathToFileURL(outfile));

const frozen = '2026-09-23T09:22:00.000Z';
const now = () => Date.parse(frozen);
const path = '/api/v1/burrows/burrow-hq';
const request = (suffix) => new Request(`http://fixtures.local${path}${suffix}`);
async function snapshot(options = {}, looks = false) {
  const chat = createChatChannelFixtures({ now, ...options });
  const look = createLookFixtures({ now });
  const fetch = async (req) => (await chat.handle(req)) ?? new Response('{}', { status: 404 });
  const read = async (suffix) => {
    const req = request(suffix);
    const res = looks ? await look.fetch(req, fetch) : await fetch(req);
    if (!res.ok) throw new Error(`Fixture read failed: ${suffix} (${res.status})`);
    return res.json();
  };
  return { open: await read('/chats/threads?room=chat&state=open'), settled: await read('/chats/threads?room=chat&state=settled'), unread: await read('/chats/unread?room=chat') };
}
const baseline = await snapshot({}, true);
const examples = await snapshot({ handoff: 'working', newReplies: true });
const data = { frozen, assistant: agentWords(ASSISTANT_NAME), baseline, examples };
await writeFile(new URL('fixture-data.js', import.meta.url), `// Generated from the shipped fixture factories by build-data.mjs.\nwindow.CHAT_FIXTURE = ${JSON.stringify(data, null, 2)};\n`);
console.log(JSON.stringify({ assistant: data.assistant.name, open: baseline.open.threads.length, settled: baseline.settled.settledCount, exampleOpen: examples.open.threads.length }));
