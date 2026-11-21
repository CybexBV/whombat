// Shared presentation helpers for these two drawings. Never calls an application API.
(() => {
 const S=window.FINAL_STORY,{esc,icon,base}=window.FinalShell;
 const q=new URLSearchParams(location.search),platform=['desktop','phoneweb','ios','android'].includes(q.get('platform'))?q.get('platform'):'desktop',theme=q.get('theme')==='dark'?'dark':'light';
 const native=['ios','android'].includes(platform);
 document.body.dataset.text=q.get('text')==='largest'?'largest':'normal';
 const link=(screen,params={})=>new URL(`${screen}/mockup.html?${new URLSearchParams({platform,theme,...params})}`,base).href;
 const time=at=>new Intl.DateTimeFormat('en-GB',{timeZone:S.timeZone,hour:'2-digit',minute:'2-digit'}).format(new Date(at));
 const exact=at=>`${new Intl.DateTimeFormat('en-GB',{timeZone:S.timeZone,weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date(at))} at ${time(at)} · ${S.timeZone}`;
 const button=(words,action,cls='')=>`<button type="button" class="${cls}" data-action="${action}">${esc(words)}</button>`;
 const face=new URL('../../../../packages/avatars/svg/operator-head-small.svg',base).href;
 function modal(title,body,actions=button('Close','close')) {
  const opener=document.activeElement,d=document.createElement('dialog');d.className='local-dialog';d.setAttribute('aria-labelledby','local-title');
  d.innerHTML=`<header><h2 id="local-title">${esc(title)}</h2><button class="icon-button" data-dismiss aria-label="Close ${esc(title)}">${icon('close')}</button></header><div class="local-body">${body}</div><div class="dialog-actions">${actions}</div>`;
  document.body.append(d);d.showModal();(d.querySelector('[data-initial]')||d.querySelector('[data-dismiss]')).focus();
  d.addEventListener('click',ev=>{const b=ev.target.closest('[data-dismiss],[data-action]');if(b)d.close(b.dataset.action||'close');});
  d.addEventListener('close',()=>{d.remove();opener?.focus({preventScroll:true});});return d;
 }
 const preview=(title,copy)=>modal(title,`<p>${esc(copy)}</p>`);
 function readState(scope,state) {
  if(state==='loading')return `<section class="read-state" role="status" aria-label="Loading ${esc(scope)}"><p>Loading ${esc(scope)}…</p><div class="skeletons" aria-hidden="true"><i></i><i></i><i></i></div></section>`;
  if(state==='empty')return `<section class="read-state empty"><span class="empty-icon" aria-hidden="true">${icon(scope==='the Inbox'?'inbox':'chat')}</span><h2>${scope==='the Inbox'?'All good. Nothing needs you.':'No approval to show.'}</h2><p>${scope==='the Inbox'?`New questions and things that need you appear here.`:'Open a request from Chat or the Inbox.'}</p><a class="button" href="${link(scope==='the Inbox'?'chat-list':'inbox')}">${scope==='the Inbox'?'Back to Chat':'Open Inbox'}</a></section>`;
  return `<section class="read-state problem" role="status"><h2>Couldn’t ${state==='saved-failed'?'refresh':'read'} ${esc(scope)}.</h2><p>${state==='saved-failed'?'Showing the saved details already on this device.':'There’s no saved copy to show on this device yet.'}</p><div class="recovery">${button('Try again','retry')}<button data-action="ask">Ask ${esc(S.assistant)}</button></div><details><summary>More detail</summary><code>The fixture read did not answer.<br>${scope==='the Inbox'?'home.overview':'approvals.get'}</code></details></section>`;
 }
 function bindRead(scope) {
  document.addEventListener('click',ev=>{const a=ev.target.closest('[data-action]')?.dataset.action;if(a==='retry')document.querySelector('#announcements').textContent=`Reading ${scope} again…`;if(a==='ask')preview(`Ask ${S.assistant}`,`Please check why I couldn’t read ${scope}. Don’t send an approval or run its action.`);});
 }
 function announce(text){document.querySelector('#announcements').textContent=text;}
 window.FinalReview={S,q,platform,theme,native,link,time,exact,esc,icon,button,face,modal,preview,readState,bindRead,announce};
})();
