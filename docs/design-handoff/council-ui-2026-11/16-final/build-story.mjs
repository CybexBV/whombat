// Read-only fixture export for a single cross-platform design story. No app writes or tests.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const outfile = resolve('.whombat/16-story-source.mjs');
await build({stdin:{contents:`
export { createAssistantFixtures, assistantAgent } from './apps/mobile/src/fixtures/assistant.ts';
export { agentWords } from './packages/client/src/agentName.ts';
export { mara } from './packages/fixtures/src/principals.ts';
`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',define:{'import.meta.env':'{}'},outfile});
const { createAssistantFixtures, assistantAgent, agentWords, mara } = await import(pathToFileURL(outfile));
const frozen = '2026-09-23T12:05:00.000Z';
const fx = createAssistantFixtures({now:()=>new Date(frozen),emit:()=>{},setTimer:()=>0,every:()=>()=>{},chat:true,si:false,looks:false,tasks:false,signIns:false,councils:false,services:false,localModel:false});
const get = async (id,params={},search={}) => {
 const response = await fx.handle(id,{burrow:'lumio',...params},undefined,new URL('http://fixtures.local/?'+new URLSearchParams(search)));
 if (!response?.ok) throw new Error('Fixture unavailable: '+id);
 return response.json();
};
const chats = await get('chats.list');
const room = chats.chats.find(c=>c.room==='chat'||c.type==='chat'||c.title==='Chat') ?? chats.chats[0];
const conversationId = room.conversationId ?? room.id;
const list = await get('messages.list',{conversationId});
const threads = await get('chats.threads',{}, {state:'open'});
const allThreads = await get('chats.threads');
const threadBodies = {};
for (const thread of allThreads.threads) threadBodies[thread.rootId] = await get('messages.thread',{messageId:thread.rootId});
const home = await get('home.overview');
const assistant = agentWords(assistantAgent().name).name;
const loadSnapshot = async (file,name) => {const context={};runInNewContext(await readFile(new URL(file,import.meta.url),'utf8')+';this.snapshot='+name,context);return context.snapshot;};
const round13All = await loadSnapshot('../13-overview-server/fixture.js','FIXTURE');
const round13 = round13All.native;
const round14 = await loadSnapshot('../14-find-files/fixture.js','DATA');
const detail = await get('hosts.getServer',{serverId:'pve-02'});
const webReads = JSON.parse(await readFile(new URL('../13-overview-server/web-fixture.json',import.meta.url),'utf8'));
const automations = webReads.automations;
const source = {
 frozen,timeZone:'Europe/Amsterdam',assistant,person:{id:mara.id,name:mara.name},burrow:'Burrow HQ',
 inbox:home.needsYou,needsYouCount:home.needsYou.length,feedbackUnread:chats.chats.find(c=>c.room==='feedback').unread,chatBadge:chats.chats.reduce((total,c)=>total+c.unread,0),
 conversationId,roots:list.messages.filter(m=>threads.threads.some(t=>t.rootId===m.id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),
 threads:threads.threads,settled:allThreads.threads.filter(t=>t.settled),threadBodies,
 servers:round13.cards.map(c=>({id:c.id,name:c.name,state:c.pill.word,reportAt:c.sampleAt,figures:c.tiles.map(t=>({key:t.key,value:t.value,unit:t.unit,sub:t.sub}))})),
 pve02:{state:'Running warm',readingAt:'2026-09-23T12:03:00.000Z',server:detail.server,live:detail.live,figures:round13.dashboard.panels.find(p=>p.kind==='kpis').items.map(({key,label,value,sub,meter})=>({key,label,value:key==='hottest'?sub.match(/[\d.]+/)[0]+' °C':value,sub:key==='hottest'?'CPU package':sub,meter})),notices:round13.dashboard.panels.find(p=>p.kind==='notices').items},
 connection:{id:'con_ha',name:'Home Assistant',state:'Needs a look',source:'packages/fixtures/src/servicePages.ts; 15-native-cards',checkedAt:null},
 automations:automations.automations,automationRows:round13All.web.automationRows,automationReadAt:webReads.frozen,schedules:round13.schedules,
 files:{source:'apps/web/src/app/filesFixtures.ts; 14-find-files',spaces:[{name:'feat/invoice-pdf',count:4,size:'136 MB',lastAdded:'11:20'},{name:'Chat',count:3,size:'488 bytes',lastAdded:'11:04'}],names:['Drawings','invoice-pdf-brief.pdf','invoices-q3.csv']},
 usage:round14.spend,vault:[...round14.vault.entries.entries,{id:'vlt_shop',name:'Shop admin',kind:'login',secret:{set:true},check:null,source:'apps/mobile/src/fixtures/chatChannel.ts vaultSaved; metadata only'}],
};
// Shared shell metadata and the brief schedule use the existing native fixture identities.
source.briefSchedule={"kind":"evening","enabled":true,"time":"18:00","days":"weekdays","timeZone":"Europe/Amsterdam","source":"5cf15c134:apps/mobile/src/fixtures/brief.ts EVENING_BRIEF.schedule; settings/schedule.js"};
source.shellThings=[{"kind":"server","id":"blackbox","name":"blackbox","system":"Unraid","logo":"unraid"},{"kind":"server","id":"pve-02","name":"pve-02","system":"Proxmox VE","logo":"proxmox"},{"kind":"server","id":"pve-01","name":"pve-01","system":"Proxmox VE","logo":"proxmox"},{"kind":"server","id":"the-falcon","name":"the-falcon","system":"Debian","logo":"debian"},{"kind":"server","id":"thetitan","name":"thetitan","system":"Debian","logo":"debian"},{"kind":"connection","id":"con_ha","name":"Home Assistant","system":"Home Assistant","logo":"homeassistant"},{"kind":"device","id":"dvp_heatpump","name":"Heat pump","system":"Daikin Altherma","logo":null},{"kind":"connection","id":"con_unifi","name":"UniFi","system":"UniFi Network","logo":"unifi_network"},{"kind":"connection","id":"con_hetzner","name":"Hetzner","system":"Hetzner","logo":"hetzner"},{"kind":"connection","id":"con_mail","name":"Mail","system":"Google Mail","logo":"gmail"}];
// Fleet and detail are different fixture feeds. At the chosen report time, reuse the
// detail values in every pve-02 summary; retain the raw fleet feed only in step 13.
const pve = source.servers.find(s=>s.id==='pve-02');
pve.figures=source.pve02.figures;
pve.state=source.pve02.state;
await writeFile(new URL('story.js',import.meta.url),'// Generated by build-story.mjs. Fixture world only; see STORY.md.\nwindow.FINAL_STORY = '+JSON.stringify(source,null,2)+';\n');
console.log(JSON.stringify({assistant,conversationId,roots:source.roots.length,needsYou:source.needsYouCount,threads:Object.keys(threadBodies).length,pveLive:detail.live}));
