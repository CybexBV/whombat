// Destination previews specify the navigation home only; they are not final screen deliverables.
(() => {
 const S=window.FINAL_STORY,{mount,esc,icon,base}=window.FinalShell,p=new URLSearchParams(location.search);
 const platform=p.get('platform')||'desktop',theme=p.get('theme')==='dark'?'dark':'light',place=p.get('place')||'chat';
 const native=['ios','android'].includes(platform);
 const names=Object.fromEntries(window.FinalShell.places);
 const thing=S.shellThings.find(t=>t.id===p.get('connection'));
 const title=thing?.name||names[place]||({thread:'Thread',server:'pve-02'}[place])||'Chat';
 const chat=new URL('chat-list/mockup.html?'+new URLSearchParams({platform,theme}),base).href;
 const scope={files:'Files shared in your conversations.',vault:`Sign-ins and secrets ${S.assistant} can use for you.`,usage:`How much AI ${S.assistant} used on this Whombat.`,chat:`You and ${S.assistant}`};
 let body;
 if(place==='connection'&&thing)body=`<section class="destination-card">${window.FinalShell.logo(thing.logo)}<h2>${esc(thing.name)}</h2><p>${esc(thing.system)}</p><p>This is the ${esc(thing.name)} destination from Places and Search.</p><a class="button" href="${new URL('overview/mockup.html?'+new URLSearchParams({platform,theme}),base)}">Overview</a></section>`;
 else if(place==='vault')body=S.vault.map(e=>`<div class="destination-row"><strong>${esc(e.name)}</strong><small>${e.check?.status==='failing'?'Not working · The password stopped working.':e.check?.status==='reached'?'Sign-in available · secret closed':e.check?.status==='unchecked'?'Secret closed · not checked':'Saved from Chat · secret closed'}</small></div>`).join('');
 else if(place==='files')body=S.files.spaces.map(s=>`<div class="destination-row"><strong>${esc(s.name)}</strong><small>${s.count} files · ${s.size} · 23 Sep, ${s.lastAdded}</small></div>`).join('');
 else if(place==='usage')body=`<section class="destination-card"><h2>Provider coverage</h2><p>All providers that reported usage here, combined. These numbers don’t name individual providers.</p><p>Prepared 23 Sep 2026, 11:22 · Europe/Amsterdam</p></section>`+[['today','Today','23 Sep, 00:00–11:22'],['week','Last 7 days','16 Sep, 11:22–23 Sep, 11:22'],['month','Last 30 days','24 Aug, 11:22–23 Sep, 11:22']].map(([id,label,range])=>{const n=S.usage.totals[id];return `<section class="destination-card"><h2>${label}</h2><p>${range}</p><strong class="metric">${(n.inputTokens+n.outputTokens).toLocaleString('en-GB')}</strong><p>tokens · ${n.turns} finished turns<br>$${n.costUsd.toFixed(2)} USD reported cost<br>${n.unreportedTurns} turns with no usage report</p></section>`;}).join('');
 else if(place==='thread') {const t=S.threadBodies[p.get('root')||'msg_chat-memory'];body=t?`<section class="destination-card"><h2>${esc(t.root.text)}</h2><p>${t.replies.length} replies</p>${t.replies.map(m=>`<p>${esc(m.text)}</p>${m.card?.kind==='approval'?`<a class="button" href="${chat}">Open Chat</a>`:''}`).join('')}</section>`:'';}
 else body=`<p>This is the shared navigation specimen. The final ${esc(title)} screen belongs to its named cell in the final gallery.</p><p><a href="index.html#${place}">Open the final gallery</a></p>`;
 mount({platform,theme,active:place==='thread'?'chat':place,title,hideTabs:native&&['vault','files','usage','thread','server','connection'].includes(place),header:`<header class="destination-head">${native&&['vault','files','usage','thread','server','connection'].includes(place)?`<a class="back" href="${chat}" aria-label="Back to Chat">${platform==='ios'?'‹ Chat':icon('arrow')}</a>`:''}<h1>${esc(title)}</h1><p>${esc(scope[place]||'')}</p></header>`,content:`<div class="destination-content">${body}</div>`});
})();
