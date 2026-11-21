// Reuse 09's content, Settle/Undo, folded heads-ups and write-only Vault. No other workstream is edited.
const draw09=render;
function mountPhoneShell(){
 const shell=document.querySelector('.shell');
 const toolbar=document.createElement('div');toolbar.className='phone-toolbar';toolbar.innerHTML=`<button type="button" aria-label="Open the sidebar" aria-haspopup="dialog">☰</button><a href="mockup.html?platform=phone&theme=${theme}&screen=search"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></svg>Search</a>`;shell.prepend(toolbar);
 let drawer=document.querySelector('#phone-drawer');if(!drawer){drawer=document.createElement('dialog');drawer.id='phone-drawer';drawer.className='phone-drawer';drawer.setAttribute('aria-label','Whombat navigation');drawer.innerHTML='<h2>Whombat</h2>'+['Search','Chat','Inbox','Overview','Automations','Files','Vault','Usage','Settings'].map(label=>`<a href="${['Inbox','Vault'].includes(label)?'phone-states.html':'mockup.html'}?platform=phone&theme=${theme}&screen=${label.toLowerCase()}">${label}</a>`).join('')+'<button type="button">Close</button>';document.body.append(drawer);}
 const opener=toolbar.querySelector('button');opener.addEventListener('click',()=>drawer.showModal());drawer.querySelector('button').onclick=()=>drawer.close();drawer.onclose=()=>opener.focus();
 if(new URLSearchParams(location.search).get('text')==='largest')document.documentElement.classList.add('phone-web-large');
}
render=function(){draw09();mountPhoneShell();};mountPhoneShell();
Promise.all([document.fonts.load('400 16px "Bricolage Grotesque"'),document.fonts.load('400 12px "DM Mono"')]).then(()=>document.fonts.ready).then(()=>document.documentElement.dataset.ready='true');
