/**
 * VM tests only (runtime-live-turn, NX-75): the world a live turn needs on a managed appliance, made with the server's
 * own code at the pinned Whombat commit. A managed runtime takes people's writes only through the encrypted session
 * (control, relay, a claimed box); a VM test has none of them, so this loads the server's integration-test world
 * (`seed/test-world`, as `useManagedRuntime({ seed: true })` does) and commits one message through the commit pipeline,
 * exactly as the int tests do. The running server then hands the queued dispatch to the runner like any other.
 *
 * Built by vm-tests/common/live-turn.nix: copied into apps/server/src of the pinned source and bundled with esbuild
 * (the runtime bundle's options). Runs with the server unit's environment and credentials, as its user; the server
 * and the runner are stopped meanwhile.
 *
 *   world <text>   seeds the world (once) and sends “@Dusty <text>” in #billing as Mara; prints the ids as JSON.
 *
 * Dusty is the seed's researcher agent with provider `claude` and the `requester` credential source (a managed team
 * agent's default after onboarding, SUB-29): the turn runs on the sign-in of whoever asked, Mara.
 */
import { eq } from 'drizzle-orm';
import { sendMessage } from './commands/messages';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { principals } from './db/schema/index';
import { loadSeedWorld } from './seed/load';
import { IDS, TEST_BURROW_ID, testWorld } from './seed/test-world';
import { consoleLogger, createServices } from './services';

const text = process.argv[2] ?? 'hello';
const config = loadConfig();
const { sql } = createDb(config.DATABASE_URL);
const services = createServices({ config, sql, log: consoleLogger });

const [seeded] = await services.db.select().from(principals).where(eq(principals.id, IDS.dusty));
if (!seeded) {
  const world = testWorld();
  for (const a of world.agents)
    if (a.id === IDS.dusty)
      a.runtime = { provider: 'claude', credentialSource: { kind: 'requester', fallback: null } } as unknown as typeof a.runtime;
  await loadSeedWorld(services, world);
}
const [mara] = await services.db.select().from(principals).where(eq(principals.id, IDS.mara));
const [dusty] = await services.db.select().from(principals).where(eq(principals.id, IDS.dusty));
const res = await services.pipeline.commit(
  sendMessage,
  { conversationId: IDS.billing, text: `@Dusty ${text}` },
  { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
);
if (res.status !== 'ok') {
  process.stderr.write(`send failed: ${JSON.stringify(res)}\n`);
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({
    accountId: mara?.accountId ?? null,
    agentId: IDS.dusty,
    agentRuntime: dusty?.runtime ?? null,
    conversationId: IDS.billing,
    messageId: res.result.id,
  })}\n`,
);
process.exit(0);
