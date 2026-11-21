// Child process for the FileKeyStore race test: waits for the start signal, then loadOrCreateIdentity.
import { existsSync } from 'node:fs';
import { loadOrCreateIdentity } from '../../src/index.js';
import { FileKeyStore } from '../../src/node/index.js';

const [dir, go] = process.argv.slice(2) as [string, string];
// Loaded and waiting: the test starts the race once every worker says so.
process.stdout.write('ready\n');
while (!existsSync(go)) await new Promise((r) => setTimeout(r, 1));
const id = await loadOrCreateIdentity(new FileKeyStore(dir), 'content');
process.stdout.write(id.peerId);
