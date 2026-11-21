// Rebuild the static snapshot from the existing fixture world and shared view helpers. No real session.
// From the repository root: node --import tsx docs/design-handoff/council-ui-2026-11/07-phone-comfort/fixture.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { councilThreads } from '../../../../apps/web/src/app/councilFixtures.ts';
import { councilCardView } from '../../../../packages/client/src/council.ts';
import { delegationCardView } from '../../../../packages/client/src/delegation.ts';
import { defaultFakeDeskWorld } from '../../../../packages/client/src/desk/fakeWorld.ts';
const here = new URL('.', import.meta.url);
const f = JSON.parse(await readFile(new URL('fixture.json', here), 'utf8'));
const baseline = JSON.parse(await readFile(new URL('../01-groundwork/capture.json', here), 'utf8'));
f.assistant = baseline.find(r => r.id === 'chat-list' && r.platform === 'phone-web').assistantName;
const now = Date.parse(f.date);
const messages = councilThreads({ made: now, person: 'person_fixture', bot: 'assistant_fixture', message: x => x });
const council = messages.find(m => m.card?.kind === 'council' && m.card.what === 'research').card;
const delegation = messages.find(m => m.card?.kind === 'delegation' && m.card.stage === 'working').card;
const cv = councilCardView(council, now), dv = delegationCardView(delegation, now);
f.councilHeading = cv.heading;
f.councilStage = cv.stage;
f.members = cv.members.map(m => ({ name:m.name, provider:m.provider, status:m.status, time:m.elapsed, mark:m.mark, letter:m.letter, answer:m.answer?.split('\n\n')[0].replaceAll('**','') || null }));
f.delegationHeading = dv.heading;
f.delegationStage = dv.stage;
f.tasks = dv.tasks;
f.folded = dv.folded;
const desk = defaultFakeDeskWorld();
f.desk = { name: desk.burrow, servers: desk.servers.slice(0,2).map(s=>({name:s.name,line:s.line})) };
await writeFile(new URL('fixture.json', here), JSON.stringify(f, null, 2) + '\n');
await writeFile(new URL('fixture.js', here), 'window.PHONE_FIXTURE = ' + JSON.stringify(f, null, 2) + ';\n');
