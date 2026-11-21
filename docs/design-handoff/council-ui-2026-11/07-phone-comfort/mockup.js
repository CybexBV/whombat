const f = window.PHONE_FIXTURE;
const assistant = f.assistant;
const p = new URLSearchParams(location.search);
const platform = p.get('platform') === 'android' ? 'android' : 'ios';
const screen = p.get('screen') || 'chat';
const large = p.get('variant') === 'raised';
const theme = p.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;
const icons = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  arrow: '<path d="m12 19-7-7 7-7M5 12h15"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-10a9.5 9.5 0 0 1 19 0Z"/>',
  inbox: '<path d="M4 4h16l2 12v4H2v-4L4 4Z M2 15h6l2 3h4l2-3h6"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  automation: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 3v3l3 2 1 3h5l1-3 3-1 3-3-2-3V8l-3-2-1-3H9Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  send: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  file: '<path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M9 16a5 5 0 0 1 6 0M12 20h.01"/>',
  battery: '<rect x="2" y="6" width="18" height="12" rx="2"/><path d="M22 10v4M5 9h12v6H5Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.more}</svg>`; }
function iconButton(name, label, attrs = '') { return `<button class="icon-button" aria-label="${label}" ${attrs}>${icon(name)}</button>`; }
function avatar(bot = false) { return bot ? '<span class="avatar" aria-hidden="true"><img src="../../five-agents/svg/operator-head.svg" alt=""></span>' : '<span class="avatar" aria-hidden="true">MO</span>'; }
function system() { return `<div class="system" aria-hidden="true"><span>${f.clock}</span><span class="system-icons">${icon('wifi')}${icon('battery')}</span></div>`; }
const tabs = [['chat','Chat'],['inbox','Inbox'],['overview','Overview'],['automation','Automations'],['settings','Settings']];
function tabbar() {
  return `<nav class="tabs" aria-label="Main navigation">${tabs.map(([i,t])=>`<button aria-label="${t}" ${t==='Chat'?'aria-current="page"':''}>${icon(i)}<span>${t}</span></button>`).join('')}</nav>`;
}
function header() {
  return `<header class="header"><h1>Chat</h1>${feedbackFits()?'<button class="text-button" data-feedback>Feedback</button>':''}${iconButton('more','More in Chat','data-header aria-haspopup="dialog" aria-expanded="false"')}</header>`;
}
function feedbackFits() {
  const width=screen==='side'?(large?206:318):390;
  const scale=large?(platform==='ios'?2.4:2):1.6;
  return 50+6+8*8.4*scale+20 <= width-32-4*14*scale;
}
function backbar(title='Chat') {
  return `<div class="backbar">${platform==='ios'?`<button class="text-button" data-back>${icon('back')}${title}</button>`:iconButton('arrow',`Back to ${title}`,'data-back')}</div>`;
}
function author(bot=false, time='09:41', action=false) {
  const who = bot ? assistant : f.person;
  return `<div class="author">${avatar(bot)}<div class="byline"><div class="name">${who}</div><div class="time">${time}</div></div>${action?iconButton('more',`Actions for ${who}’s message at ${time}`,'data-message aria-haspopup="dialog" aria-expanded="false" aria-controls="sheet"'):''}</div>`;
}
function composer(reply=false) {
  const placeholder = reply ? 'Reply…' : `Ask ${assistant} anything`;
  return `<div class="composer"><textarea aria-label="${placeholder}" placeholder="${placeholder}" rows="1"></textarea><div class="composer-tools"><span class="tool-pair"><button class="text-button" aria-label="Attach a file">${icon('file')} File</button><button class="icon-button" aria-label="Choose AI">C</button></span><span class="tool-pair">${iconButton('mic','Dictate a message')}${iconButton('send','Send message','aria-disabled="true"')}</span></div></div>`;
}
function approvalDoor() { return `<section class="card approval-door" aria-label="${assistant} needs your OK"><p class="eyebrow">${assistant} needs your OK</p><h2 class="card-title">${f.approval}</h2><p class="card-sub">${f.consequence}.</p><a class="button" href="?platform=${platform}&screen=approval&theme=${theme}${large?'&variant=raised':''}">Review and answer ›</a></section>`; }
function chat() {
  return `${header()}<main class="scroll" aria-label="Chat messages"><p class="day">Today</p><article class="message" tabindex="0" aria-label="${f.person}, 09:41. ${f.question}">${author(false,'09:41',platform==='web')}<button class="subject" aria-label="pve-02, Needs a look"><span class="dot" aria-hidden="true"></span>pve-02</button><p class="words">${f.question}</p><button class="replies" aria-label="3 replies, Waiting for you, open the thread" data-thread>3 replies <span class="wait"><span class="dot" aria-hidden="true"></span>Waiting for you</span>${icon('next')}</button></article><article class="message" tabindex="0" aria-label="${f.person}, 10:12. Is there new firmware for the access points?">${author(false,'10:12',platform==='web')}<p class="words">Is there new firmware for the access points?</p><button class="replies" data-thread>${assistant} is working ${icon('next')}</button></article></main>${composer()}${platform==='web'?'':tabbar()}`;
}
function approval() {
  return `${backbar('Chat')}<main class="scroll" aria-label="Approval"><div class="approval-person">${avatar(true)}<div><p class="eyebrow">${assistant} needs your OK</p><div class="time">${assistant} · 09:44</div></div></div><h1 class="approval-title">${f.approval}</h1><p class="approval-copy">${f.consequence}.</p><details><summary>Technical details</summary><p>servers · server_command</p><p>Restarting a server always asks a person.</p></details><div class="lasting"><button class="text-button" data-lasting>Don’t ask again for pve-02…</button></div></main><footer class="approval-footer" aria-label="Answer for this time"><button class="button" data-answer>Yes, now</button><button class="button" data-answer>Yes, tonight</button><button class="button" data-answer>No</button></footer>`;
}
function council() {
  return `${backbar()}<main class="scroll" aria-label="Council thread"><section class="card" aria-label="Council, Back up the NAS offsite"><h1 class="card-title">${f.councilHeading}</h1><p class="card-sub">${f.councilStage}</p>${f.members.map((m,i)=>`<div class="member ${i===2?'quiet':''}" role="group" aria-label="${m.name}, ${m.provider}: ${m.status}, ${m.time}"><span class="member-mark ${i===0?'working':''}" aria-hidden="true">${m.mark?`<img src="../../../../packages/brand/assets/marks/${m.mark}.svg" alt="">`:m.letter}</span><div><div class="member-name">${m.name}</div><div class="secondary">${m.provider}</div><div class="member-state">${m.status} <span class="member-time">· ${m.time}</span></div>${i===1?'<details><summary aria-label="Read its answer: GPT 6.1 Sol">Read its answer</summary><p>${m.answer}</p><button class="text-button">The rest is in T3 Code</button></details>':''}</div></div>`).join('')}<div class="card-actions"><button class="text-button" data-stop>Stop</button><button class="text-button">Change who sits on it</button></div></section></main>`;
}
function taskRow(t) {
  return `<div class="member" role="group" aria-label="${t.n}. ${t.title}, ${t.program || ''}, ${t.status}"><span class="member-mark ${t.working?'working':''}" aria-hidden="true">${t.done?'✓':t.n}</span><div><div class="member-name">${t.title}</div>${t.program?`<div class="secondary">${t.program}</div>`:''}<div class="member-state">${t.status}${t.elapsed?` <span class="member-time">· ${t.elapsed}</span>`:''}</div>${t.detail?`<div class="secondary">${t.detail}</div>`:''}${t.pr||t.url||t.stoppable?`<div class="task-links">${t.pr?'<button class="text-button">Pull request</button>':''}${t.url||t.stoppable?iconButton('more',`More for ${t.title}`,`data-task-menu data-task="${t.n}" aria-haspopup="dialog" aria-expanded="false"`):''}</div>`:''}</div></div>`;
}
function delegation() {
  return `${backbar()}<main class="scroll" aria-label="Delegation thread"><section class="card"><h1 class="card-title">${f.delegationHeading}</h1><p class="card-sub">${f.delegationStage}</p>${f.tasks.map(taskRow).join('')}<details><summary>${f.folded.label}</summary>${f.folded.tasks.map(taskRow).join('')}</details><div class="card-actions"><button class="text-button" data-stop>Stop</button></div></section></main>`;
}
function thread() { return `${backbar()}<main class="scroll" aria-label="Thread">${author(true,'09:44')}<p class="words">Sure. It takes effect after a restart, so I’d do it tonight.</p>${approvalDoor()}</main>${composer(true)}`; }
function side() {
  return `<div class="side-layout ${large?'large-side':''}"><nav class="side-tabs" aria-label="Main navigation">${tabs.map(([i,t])=>`<button aria-label="${t}" ${t==='Chat'?'aria-current="page"':''}>${icon(i)}${t}</button>`).join('')}</nav><div class="side-body">${header()}<main class="scroll"><div class="name">${f.person}</div><p class="words">${f.question}</p><button class="replies" data-thread>3 replies <span class="wait"><span class="dot"></span>Waiting for you</span></button></main></div></div>`;
}
function desk() {
  return `${backbar('Screen')}<main class="scroll"><h1 class="card-title">Preview</h1><div class="desk-demo"><div class="desk-preview" role="img" aria-label="Preview of the desk screen: pve-02 and pve-01, fixed-size miniature"><div class="desk-canvas" data-theme="dark"><div class="desk-top">${f.desk.name}</div><strong class="desk-clock">${f.clock}</strong><div class="desk-tiles">${f.desk.servers.map(s=>`<div><strong>${s.name}</strong><span>${s.line}</span></div>`).join('')}</div></div></div></div></main>`;
}
function dialogShell() { return '<dialog id="sheet"><div class="dialog-head"><h2 id="sheet-title"></h2><button class="icon-button" data-close aria-label="Close">'+icon('close')+'</button></div><div id="sheet-body"></div></dialog>'; }
const renderers = {chat,approval,council,delegation,thread,side,desk};
document.getElementById('app').innerHTML = `<div class="phone ${platform==='web'?'web':'native'} ${platform} ${large?'large':''}">${system()}${(renderers[screen]||chat)()}${platform==='web'?'':'<div class="home-indicator" aria-hidden="true"></div>'}${dialogShell()}</div>`;
const dialog = document.querySelector('dialog');
let opener;
function openSheet(button,title,body) {
  opener = button;
  button?.setAttribute('aria-expanded','true');
  document.getElementById('sheet-title').textContent = title;
  document.getElementById('sheet-body').innerHTML = body;
  dialog.setAttribute('aria-labelledby','sheet-title');
  dialog.showModal();
  (dialog.querySelector('.menu-item') || dialog.querySelector('[data-close]')).focus();
}
function menuItems(names) { return names.map((name)=>`<button class="menu-item" data-menu-item>${name}</button>`).join(''); }
document.addEventListener('click',e=>{
  const button = e.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-header')) openSheet(button,'More in Chat',menuItems(!feedbackFits()?['Feedback','Settled',`What ${assistant} did`,'Files']:['Settled',`What ${assistant} did`,'Files']));
  else if (button.hasAttribute('data-lasting')) openSheet(button,`Let ${assistant} do this on pve-02 without asking?`,`<p class="words">Next time it does it and tells you after. You can change this on pve-02’s page in Overview.</p>${menuItems(['Keep asking',`Let ${assistant} do it`])}`);
  else if (button.hasAttribute('data-task-menu')) { const task=[...f.tasks,...f.folded.tasks].find(t=>t.n===Number(button.dataset.task));openSheet(button,task.title,menuItems([...(task.url?['Open in T3 Code']:[]),...(task.stoppable?['Stop this task']:[])])); }
  else if (button.hasAttribute('data-stop')) openSheet(button,screen==='council'?'Stop the council?':'Stop every task?',menuItems(['Keep going','Stop']));
  else if (button.hasAttribute('data-menu-item') && button.textContent==='Stop this task') openSheet(opener,'Stop this task?',menuItems(['Keep going','Stop']));
  else if (button.hasAttribute('data-close')||button.hasAttribute('data-menu-item')) dialog.close();
  else if (button.hasAttribute('data-thread')) location.search=`?platform=${platform}&screen=thread&theme=${theme}${large?'&variant=raised':''}`;
  else if (button.hasAttribute('data-back')) location.search=`?platform=${platform}&screen=chat&theme=${theme}${large?'&variant=raised':''}`;
});
dialog.addEventListener('click',e=>{ if(e.target===dialog && (e.offsetX<0 || e.offsetY<0 || e.offsetX>dialog.clientWidth || e.offsetY>dialog.clientHeight)) dialog.close(); });
dialog.addEventListener('close',()=>{ opener?.setAttribute('aria-expanded','false'); opener?.focus({preventScroll:true}); });
for(const details of document.querySelectorAll('.member details')) {
  const summary=details.querySelector('summary');
  if(summary.textContent==='Read its answer') details.addEventListener('toggle',()=>{ summary.textContent=details.open?'Hide its answer':'Read its answer';summary.setAttribute('aria-label',`${summary.textContent}: GPT 6.1 Sol`); });
}
// Model the shipped per-label fit: each side-tab word may shrink only as far as 60% of its capped size.
if(screen==='side' && !large) document.fonts.ready.then(()=>{
  const ctx=document.createElement('canvas').getContext('2d');
  for(const button of document.querySelectorAll('.side-tabs button')) {
    ctx.font='500 17.6px "Bricolage Grotesque"';
    button.style.fontSize=Math.max(10.56,Math.min(17.6,17.6*68/ctx.measureText(button.textContent).width))+'px';
  }
});
