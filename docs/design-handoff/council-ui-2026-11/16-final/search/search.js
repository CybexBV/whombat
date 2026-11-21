// Search over the shared fixture snapshot only. No request, AI answer, or write runs here.
(() => {
 const S=window.FINAL_STORY,F=window.FinalShell,e=F.esc;
 const P=new URLSearchParams(location.search);
 const platform=['desktop','phoneweb','ios','android'].includes(P.get('platform'))?P.get('platform'):'desktop';
 const theme=P.get('theme')==='dark'?'dark':'light',native=['ios','android'].includes(platform);
 const state=P.get('state')||'normal',from=P.get('from')||'chat';
 let query=P.has('q')?P.get('q'):state==='empty'?'':state==='no-results'?'garden shed':'pve';
 document.body.dataset.text=P.get('text')==='largest'?'largest':'normal';
 const entries=[];
 for(const t of S.threads)entries.push({group:'Chats',title:t.text,line:t.waiting?'Waiting for you':t.working?`${S.assistant} is working`:t.replyCount?`${t.replyCount} ${t.replyCount===1?'reply':'replies'}`:'No replies yet',icon:'chat',place:'thread',extra:{root:t.rootId},terms:t.text});
 for(const t of S.shellThings) {
  const server=S.servers.find(s=>s.id===t.id);
  const line=server?`${t.system} · ${server.state}`:t.id==='con_ha'?`${t.system} · ${S.connection.state}`:t.kind==='device'?'Daikin Altherma · Learning':t.system;
  entries.push({group:'Things',title:t.name,line,logo:t.logo,icon:t.kind==='device'?'thermometer':'overview',place:t.kind==='server'?'server':t.kind==='device'?'thread':'connection',extra:t.kind==='server'?{server:t.id}:t.kind==='device'?{root:'msg_chat-heat'}:{connection:t.id},terms:t.system});
 }
 entries.push({group:'Settings',title:'Evening brief',line:`Weekdays at ${S.briefSchedule.time} · Amsterdam`,icon:'clock',place:'settings',extra:{view:'brief',via:'search'},terms:'schedule time '+S.assistant});
 entries.push({group:'Settings',title:'Notifications',line:'When this device alerts you',icon:'bell',place:'settings',extra:{view:'group',group:'notifications'},terms:'alerts'});
 entries.push({group:'Settings',title:'Theme',line:'Light and dark on this device',icon:'theme',place:'settings',extra:{view:'theme'},terms:'appearance'});
 const descriptions={chat:`You and ${S.assistant}`,inbox:'What needs you',overview:'Servers and connections',automations:'Plans and schedules',files:'Files shared in your conversations',vault:'Sign-ins and secrets',usage:`What it cost and how much ${S.assistant} worked`,settings:`You, ${S.assistant} and this Whombat`};
 F.places.filter(([id])=>id!=='search').forEach(([place,title])=>entries.push({group:'Places',title,line:descriptions[place],icon:place,place,extra:{},terms:''}));
 F.mount({platform,theme,active:'search',title:'Search',hideTabs:native,backTitle:Object.fromEntries(F.places)[from]||'Chat',content:`<div class="search-page"><h1 id="search-title" tabindex="-1">Search</h1><p class="search-intro">Chats, things, settings and places.</p><form class="search-form" role="search"><label>${F.icon('search')}<span class="sr-only">Search everything</span><input id="search-query" type="search" autocomplete="off" placeholder="Search everything" value="${e(query)}" aria-controls="search-results"></label><button class="icon-button" type="button" data-clear aria-label="Clear search">${F.icon('close')}</button></form><p class="search-meta" role="status" aria-live="polite" id="search-status"></p><div id="search-results"></div></div>`});
 function destination(item) {return F.href(item.place,{...item.extra,from:'search',q:query,searchFrom:from});}
 function row(item) {return `<a class="result" href="${destination(item)}" data-search-result><span class="result-mark" aria-hidden="true">${item.logo?F.logo(item.logo):F.icon(item.icon)}</span><span class="result-copy"><strong>${e(item.title)}</strong><small>${e(item.line)}</small></span><span class="chevron" aria-hidden="true">›</span></a>`;}
 function draw(initial=false) {
  const target=document.querySelector('#search-results'),status=document.querySelector('#search-status');
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  document.querySelector('[data-clear]').hidden=!query;
  if(initial&&state==='loading') {status.textContent='Searching…';target.innerHTML=`<section class="search-state" aria-busy="true"><h2>Looking for “${e(query)}”…</h2><div class="skeleton" aria-hidden="true"></div><div class="skeleton short" aria-hidden="true"></div></section>`;return;}
  if(initial&&state==='failed') {status.textContent='Search didn’t finish.';target.innerHTML=`<section class="search-state"><h2>Couldn’t search</h2><p>Try again to look through your chats, things, settings and places.</p><button data-retry>Try again</button></section>`;return;}
  if(!words.length) {status.textContent='';target.innerHTML=`<section class="search-state">${F.icon('search')}<h2>What are you looking for?</h2><p>Find a chat, a server, a connection or a setting by its name.</p><div class="suggestions" aria-label="Try a search">${['pve-02','Evening brief','Files'].map(word=>`<button data-suggest="${word}">${word}</button>`).join('')}</div></section>`;return;}
  const matches=entries.filter(item=>words.every(word=>`${item.title} ${item.line} ${item.terms}`.toLocaleLowerCase().includes(word)));
  status.textContent=matches.length?`${matches.length} ${matches.length===1?'result':'results'}`:'No results';
  if(!matches.length){target.innerHTML=`<section class="search-state">${F.icon('search')}<h2>No results for “${e(query)}”</h2><p>Try a shorter name or a different word.</p><button data-clear>Clear search</button></section>`;return;}
  target.innerHTML=['Chats','Things','Settings','Places'].map(group=>{const rows=matches.filter(item=>item.group===group);return rows.length?`<section class="result-group" aria-label="${group}"><h2>${group}</h2><div class="results">${rows.map(row).join('')}</div></section>`:'';}).join('');
 }
 function update(value) {query=value;draw();const u=new URL(location.href);u.searchParams.set('q',query);u.searchParams.delete('state');history.replaceState(null,'',u);}
 document.querySelector('#search-query').addEventListener('input',event=>update(event.target.value));
 document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();draw();});
 document.addEventListener('click',event=>{
  const control=event.target.closest('[data-clear],[data-suggest],[data-retry],[data-search-result]');if(!control)return;
  if(control.hasAttribute('data-clear')){document.querySelector('#search-query').value='';update('');document.querySelector('#search-query').focus();}
  if(control.dataset.suggest){document.querySelector('#search-query').value=control.dataset.suggest;update(control.dataset.suggest);document.querySelector('#search-query').focus();}
  if(control.hasAttribute('data-retry'))draw();
  if(control.hasAttribute('data-search-result'))sessionStorage.setItem('final-search-return',JSON.stringify({url:location.href,scroll:document.querySelector('#main').scrollTop,label:control.querySelector('strong').textContent}));
 });
 draw(true);
 const saved=JSON.parse(sessionStorage.getItem('final-search-return')||'null');
 if(saved?.url===location.href){document.querySelector('#main').scrollTop=saved.scroll;[...document.querySelectorAll('[data-search-result]')].find(a=>a.querySelector('strong').textContent===saved.label)?.focus({preventScroll:true});}
 else document.querySelector('#search-query').focus({preventScroll:true});
 document.documentElement.dataset.ready='true';
})();
