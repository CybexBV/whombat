// Shared drawing shell for final screens. No application requests or commands.
(() => {
  const base = new URL('.', document.currentScript.src);
  const S = window.FINAL_STORY;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    chat:'M4 4h16v12H9l-5 4Z', inbox:'m4 4-2 10v6h20v-6l-2-10ZM2 14h6l2 3h4l2-3h6',
    overview:'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
    automations:'m13 2-9 11h7l-1 9 10-12h-7Z',files:'M3 7V4h6l2 3h10v13H3ZM3 7h18',
    vault:'M5 10h14v11H5ZM8 10V7a4 4 0 0 1 8 0v3',usage:'M4 20V10m8 10V4m8 16v-7',
    settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
    places:'M4 6h16M4 12h16M4 18h16',chevron:'m15 5-7 7 7 7',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2',bell:'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4',theme:'M12 3a9 9 0 1 0 0 18V3Z',person:'M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0ZM4 22v-3a8 8 0 0 1 16 0v3',assistant:'M4 5h16v14H4ZM8 10h.01M16 10h.01M8 15h8M12 2v3',box:'m3 7 9-5 9 5v11l-9 4-9-4ZM3 7l9 5 9-5M12 12v10',screens:'M3 3h18v14H3ZM8 22h8M12 17v5',sliders:'M5 3v18M12 3v18M19 3v18M2 8h6M9 16h6M16 7h6',thermometer:'M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0ZM12 8v9',close:'m6 6 12 12M6 18 18 6',arrow:'m14 5-7 7 7 7M7 12h14',
    file:'m21 11-8 8a5 5 0 0 1-7-7l8-8a3 3 0 0 1 4 4l-8 8a1 1 0 0 1-1.5-1.5L16 7',
    mic:'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8',send:'m5 12 7-7 7 7M12 5v15',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.places}"/></svg>`;
  const places = [['search','Search'],['chat','Chat'],['inbox','Inbox'],['overview','Overview'],['automations','Automations'],['files','Files'],['vault','Vault'],['usage','Usage'],['settings','Settings']];
  const tabIds = ['chat','inbox','overview','automations','settings'];
  let config, opener;
  const href = (place, extra={}) => {
    const finalPages = {chat:'chat-list',inbox:'inbox',overview:'overview',automations:'automations',settings:'settings',vault:'vault',files:'files',usage:'usage',search:'search',server:'server',connection:'connection',thread:'thread',approval:'approval'};
    const url = new URL(finalPages[place]&&!(place==='connection'&&extra.connection&&extra.connection!=='con_ha')&&!(place==='thread'&&extra.root&&extra.root!=='msg_chat-memory') ? `${finalPages[place]}/mockup.html` : 'shell.html', base);
    const p=new URLSearchParams(location.search);
    const origin=config.active==='search' ? 'search' : ['files','vault','usage'].includes(config.active) ? p.get('from')||'chat' : config.active;
    url.search = new URLSearchParams({platform:config.platform,theme:config.theme,...(p.get('text')?{text:p.get('text')}:{}),...(['files','vault','usage','search'].includes(place)?{from:origin}:{}),...(!finalPages[place]||place==='connection'&&extra.connection&&extra.connection!=='con_ha'||place==='thread'&&extra.root&&extra.root!=='msg_chat-memory'?{place}:{}),...extra});
    return url.href;
  };
  const logo = (mark,label='') => mark ? `<img class="thing-logo" src="${new URL(`../../../../packages/brand/assets/marks/${mark}.svg`,base)}" alt="${esc(label)}">` : icon('thermometer');
  function things() {
    return [['Servers',S.shellThings?.filter(t=>t.kind==='server')||[]],['Connections',S.shellThings?.filter(t=>t.kind!=='server')||[]]].map(([title,rows])=>`<section class="shell-things" aria-label="${title}"><h2>${title}</h2><nav aria-label="${title}">${rows.map(t=>`<a href="${href(t.kind==='server'?'server':t.kind==='device'?'thread':'connection',t.kind==='server'?{server:t.id}:t.kind==='device'?{root:'msg_chat-heat'}:{connection:t.id})}" aria-label="${esc(t.name+', '+t.system)}">${logo(t.logo)}<span>${esc(t.name)}</span></a>`).join('')}</nav></section>`).join('');
  }
  const badge = place => place==='inbox'?`<span class="shell-badge problem-badge" aria-hidden="true">${S.needsYouCount}</span>`:place==='chat'?`<span class="shell-badge reply-badge" aria-hidden="true">${S.chatBadge}</span>`:'';
  const name = (id,label) => id==='inbox'?`Inbox, ${S.needsYouCount} things need you, one is not working`:id==='chat'?`Chat, ${S.chatBadge} unread reply in Feedback`:label;
  function links({tabs=false}={}) {
    return places.filter(([id])=>!tabs||tabIds.includes(id)).map(([id,label])=>`<a href="${href(id)}" aria-label="${esc(name(id,label))}" ${config.active===id?'aria-current="page"':''} data-place="${id}">${icon(id)}<span>${label}</span>${badge(id)}</a>`).join('');
  }
  function sidebar() {
    return `<aside class="sidebar" aria-label="Sidebar"><a class="burrow" href="${href('chat')}">${icon('chat')}<span>${esc(S.burrow)}</span></a><nav aria-label="Places">${links()}</nav>${things()}<div class="sidebar-person"><span class="person-avatar" aria-hidden="true">MO</span><span>${esc(S.person.name)}<small>This Whombat</small></span></div></aside>`;
  }
  function phoneBar() {
    return `<div class="phone-bar"><button class="places-trigger" data-open-places aria-haspopup="dialog" aria-controls="places-menu" aria-expanded="false">${icon('places')}<span>Places</span></button><a class="search-link" href="${href('search')}">${icon('search')}Search</a>${config.active==='inbox'?'':`<a class="needs-cue" href="${href('inbox')}" aria-label="${S.needsYouCount} things need you, open Inbox"><span class="cue-count">${S.needsYouCount}</span><span>need you</span><span aria-hidden="true">›</span></a>`}</div>`;
  }
  function nativeBar() {
    return `<div class="os-chrome" aria-hidden="true"><span>09:41</span><span>••• ▰</span></div><div class="native-places-bar"><a class="search-link" href="${href('search')}">${icon('search')}Search</a><button class="places-trigger" data-open-places aria-haspopup="dialog" aria-controls="places-menu" aria-expanded="false">${icon('places')}Places</button></div>`;
  }
  function menu() {
    return `<dialog id="places-menu" class="places-dialog" aria-labelledby="places-title"><header><h2 id="places-title">Places</h2><button class="icon-button" data-close-places aria-label="Close Places">${icon('close')}</button></header><nav aria-label="Places">${links()}</nav>${things()}</dialog>`;
  }
  const fromPlace=()=>new URLSearchParams(location.search).get('from')||'chat';
  function mount(options) {
    config={platform:'desktop',theme:'light',active:'chat',...options};
    const native = ['ios','android'].includes(config.platform);
    const old=new URLSearchParams(location.search);
    if(location.pathname.endsWith('/shell.html')&&['chat','search','inbox','overview','automations','settings','vault','files','usage','thread','server'].includes(old.get('place'))&&!(old.get('place')==='thread'&&old.get('root')&&old.get('root')!=='msg_chat-memory')) {
      const extra=Object.fromEntries(old);delete extra.place;location.replace(href(old.get('place'),extra));
    }
    document.documentElement.dataset.theme=config.theme;
    document.body.dataset.platform=config.platform;
    // Pushed pages share one native back row; screen authors retain their content headers.
    let pushBar='';
    if(native&&config.hideTabs) {
      const fragment=document.createElement('template');
      fragment.innerHTML=(config.header||'')+'<div data-shell-content>'+(config.content||'')+'</div>';
      const back=fragment.content.querySelector('a.back-link,a.back,.push-head a');
      const p=new URLSearchParams(location.search);
      let title=p.get('backTitle')||config.backTitle||back?.getAttribute('aria-label')?.replace(/^Back to /,'')||'Chat';
      let target=p.get('backHref')||config.backHref||back?.href||href(fromPlace());
      if(!p.get('backTitle')&&(p.get('from')==='search'||p.get('via')==='search')) {title='Search';target=href('search',{q:p.get('q')||'Evening brief',from:p.get('searchFrom')||'chat'});}
      back?.remove();
      fragment.content.querySelector('.push-head')?.remove();
      config.content=fragment.content.querySelector('[data-shell-content]').innerHTML;
      fragment.content.querySelector('[data-shell-content]').remove();
      const holder=document.createElement('div');holder.append(fragment.content);config.header=holder.innerHTML;
      pushBar=`<div class="native-push-bar"><a class="native-back" href="${esc(target)}" aria-label="Back to ${esc(title)}">${icon(config.platform==='ios'?'chevron':'arrow')}${config.platform==='ios'?`<span>${esc(title)}</span>`:''}</a><button class="places-trigger" data-open-places aria-haspopup="dialog" aria-controls="places-menu" aria-expanded="false">${icon('places')}Places</button></div>`;
    }
    document.body.dataset.push=String(native&&config.hideTabs===true);
    document.getElementById('app').innerHTML=`<a class="skip" href="#main">Skip to ${esc(config.title||'content')}</a><div class="app-shell">${config.platform==='desktop'?sidebar():''}<div class="shell-workspace">${config.platform==='phoneweb'?phoneBar():native?pushBar?`<div class="os-chrome" aria-hidden="true"><span>09:41</span><span>••• ▰</span></div>${pushBar}`:nativeBar():''}${config.header||''}<main id="main" tabindex="-1">${config.content||''}</main>${config.footer||''}${native&&!config.hideTabs?`<nav class="native-tabs" aria-label="Main tabs">${links({tabs:true})}</nav>`:''}</div></div>${menu()}`;
    polish();
    const dialog=document.getElementById('places-menu');
    document.querySelectorAll('[data-open-places]').forEach(button=>button.addEventListener('click',()=>{
      opener=button;button.setAttribute('aria-expanded','true');dialog.showModal();dialog.querySelector('[data-close-places]').focus();
    }));
    dialog.querySelector('[data-close-places]').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{opener?.setAttribute('aria-expanded','false');opener?.focus({preventScroll:true});});
    dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
    if(new URLSearchParams(location.search).get('places')==='open'){document.querySelector('[data-open-places]')?.click();if(new URLSearchParams(location.search).get('placesScroll')==='things')dialog.scrollTop=dialog.scrollHeight;}
    return config;
  }
  // Shared finish details live here so parallel screen owners do not edit each other's files.
  function polish() {
    const icons={'Evening brief':'clock','Notifications':'bell','Theme':'theme','You':'person',[S.assistant]:'assistant','This Whombat':'box','Screens':'screens','Advanced':'sliders'};
    document.querySelectorAll('.common-settings .row,.settings-groups .row').forEach(row=>{
      const mark=row.querySelector('.row-icon');const name=row.querySelector('strong')?.textContent;
      if(mark&&icons[name])mark.innerHTML=icon(icons[name]);
    });
    document.querySelectorAll('[data-settled-count]').forEach(el=>{const words=el.textContent.replace(/^0[\s　]*/, '');if(words!==el.textContent)el.textContent=words;});
    document.querySelectorAll('#brief-time[type="time"]').forEach(el=>{
      el.type='text';el.inputMode='numeric';el.pattern='([01][0-9]|2[0-3]):[0-5][0-9]';el.maxLength=5;el.placeholder='18:00';el.setAttribute('aria-label','Time, 24-hour format, hours and minutes');
    });
  }
  const observer=new MutationObserver(records=>{if(records.some(r=>r.target.closest?.('.edit-dialog,[data-settled-count]')||[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('#brief-time,.edit-dialog')||n.querySelector?.('#brief-time')))))polish();});
  observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  // Earlier screen drawings may still produce the old preview URLs. All entrances converge here.
  document.addEventListener('click',event=>{
    const a=event.target.closest('a[href]');if(!a)return;
    const u=new URL(a.href,location.href);
    if((a.matches('[data-place="search"],.search-link')||u.pathname.endsWith('/settings/mockup.html')&&u.searchParams.get('view')==='search')&&!u.pathname.endsWith('/search/mockup.html')) {
      event.preventDefault();event.stopImmediatePropagation();location.href=href('search',{q:u.searchParams.get('q')||'',...(['ios','android'].includes(config.platform)?{backTitle:document.querySelector('.shell-workspace h1')?.textContent.trim()||'Chat',backHref:location.href}:{})});
    } else if(['ios','android'].includes(config?.platform)&&!a.matches('.native-back')&&u.href.startsWith(base.href)&&/\/(thread|approval|vault|files|usage|search|server|connection)\/mockup\.html$/.test(u.pathname)) {
      u.searchParams.set('backTitle',document.querySelector('.shell-workspace h1')?.textContent.trim()||Object.fromEntries(places)[config.active]||'Chat');
      u.searchParams.set('backHref',location.href);a.href=u.href;
    }
  },true);
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();event.stopImmediatePropagation();location.href=href('search');}},true);
  window.FinalShell={mount,icon,logo,esc,href,places,base};
})();
