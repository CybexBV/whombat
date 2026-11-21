// Read captured fixture queries. This never contacts a Whombat.
import { readFile, writeFile } from 'node:fs/promises';
import { messageActions } from '../../../../apps/web/src/features/messaging/messageActions.ts';
import { agentWords, theAgentOf } from '../../../../packages/client/src/agentName.ts';
const records = JSON.parse(await readFile('.whombat/chat-before.json','utf8'));
const queries = records.find(r=>r.platform==='desktop'&&r.screen==='thread'&&r.theme==='light').queries;
const get = key => queries.find(q=>q.key[1]===key)?.data;
const bootstrap = get('conversations.bootstrap');
const assistant = agentWords(theAgentOf(bootstrap.principals)?.name);
const threads = get('chats.threads').pages.flatMap(p=>p.threads);
const messages = get('messages.list').pages.flatMap(p=>p.messages);
const threadData=get('messages.thread');
const actions = Object.fromEntries([...messages,...threadData.replies,threadData.root].map(m=>[m.id,{room:messageActions(m,{viewer:{id:bootstrap.me.id,kind:'person'},place:'room'}),thread:messageActions(m,{viewer:{id:bootstrap.me.id,kind:'person'},place:'thread'})}]));
const data = {
  actions,
  frozen:'2026-09-23T09:22:00.000Z', assistant,
  person:bootstrap.me, principals:bootstrap.principals,
  threads, roots:messages.filter(m=>threads.some(t=>t.rootId===m.id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),
  thread:get('messages.thread'), unread:get('chats.unread'),
  count:get('home.overview').summary.needsYou,
  native:{root:'msg_chat-memory',approval:33,times:['13:52','13:53','13:58','14:03'],firmware:'14:04',frozen:'2026-09-23T12:05:00.000Z'},
};
await writeFile(new URL('fixture.js',import.meta.url),`// Captured fixture reads; see NOTES.md for native differences.\nwindow.CHAT_DATA = ${JSON.stringify(data,null,2)};\n`);
console.log({assistant:assistant.name,roots:data.roots.length,thread:data.thread.root.id});
