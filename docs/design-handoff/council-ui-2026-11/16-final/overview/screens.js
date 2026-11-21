/* Final fixture drawings only. No requests, commands, polling or automatic sorting. */
(() => {
  const F=window.OVERVIEW_FIXTURES;
  const S=window.FINAL_STORY, Shell=window.FinalShell, {esc,icon}=Shell;
  const q=new URLSearchParams(location.search);
  const screen=document.body.dataset.screen;
  const platform=['desktop','phoneweb','ios','android'].includes(q.get('platform'))?q.get('platform'):'desktop';
  const theme=q.get('theme')==='dark'?'dark':'light', state=q.get('state')||'normal';
  const native=platform==='ios'||platform==='android';
  const hasSaved=!['loading','empty','failed'].includes(state);
  const server=S.servers.find(s=>s.id===(q.get('server')||'pve-02'))||S.servers[1];
  const automation=S.automations.find(a=>a.id===(q.get('automation')||'aut_assess-billing'));
  const view=q.get('view')||'list';
  const run=automation?.recentRuns.find(r=>r.id===q.get('run'))||automation?.lastRun;
  const name=screen==='server'?server.name:screen==='connection'?S.connection.name:screen==='overview'?'Overview':view==='run'?`Run #${run?.number}`:view==='detail'?automation.name:'Automations';
  document.body.dataset.text=q.get('text')==='largest'?'largest':'normal';
  const url=(target,extra={})=>{
    const u=new URL(`../${target}/mockup.html`,location.href);
    u.search=new URLSearchParams({platform,theme,...extra});return u.href;
  };
  const placeUrl=(place,extra={})=>{const u=new URL(place==='chat'?'../chat-list/mockup.html':'../shell.html',location.href);u.search=new URLSearchParams({platform,theme,...(place==='chat'?{}:{place}),...extra});return u.href;};
  const clock=at=>new Date(at).toLocaleTimeString('en-GB',{timeZone:S.timeZone,hour:'2-digit',minute:'2-digit'});
  const date=at=>new Date(at).toLocaleDateString('en-GB',{timeZone:S.timeZone,day:'numeric',month:'short'});
  const stamp=at=>`${date(at)}, ${clock(at)}`;
  const glyph=key=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${key==='clock'?'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>':'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01"/>'}</svg>`;
  const reading=at=>{
    const age=at?Math.floor((Date.parse(S.frozen)-Date.parse(at))/60000):null;
    return `<span class="reading">${glyph('clock')}${at?`<time datetime="${at}" title="23 September 2026, ${clock(at)} Europe/Amsterdam" aria-label="Read ${age} ${age===1?'minute':'minutes'} ago, 23 September 2026 at ${clock(at)}, Europe/Amsterdam">Read ${age} min ago</time>`:'Reading time unknown'}</span>`;
  };
  const button=(text,attrs='',cls='')=>`<button type="button" class="${cls}" ${attrs}>${text}</button>`;
  const ask=(subject,cls='')=>button(`Ask ${esc(S.assistant)}`,`data-ask="${esc(subject)}" aria-label="Ask ${esc(S.assistant)}: ${esc(subject)}"`,cls);
  const health=(text,tone='')=>`<span class="health ${tone}" ${tone==='failed'?'aria-label="Not working: '+esc(text)+'"':''}><i aria-hidden="true"></i>${esc(text)}</span>`;
  const heading=(title,sub='',actions='',back='')=>`<header class="screen-head">${back}<div class="head-row"><h1 tabindex="-1">${esc(title)}</h1>${actions?`<div class="actions">${actions}</div>`:''}</div>${sub}</header>`;
  const back=(label,href)=>`<a class="back" href="${href}" aria-label="Back to ${esc(label)}">${platform==='ios'&&(screen==='server'||screen==='connection')?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>':icon('arrow')}${platform==='android'?'':esc(label)}${platform==='android'?`<span class="sr-only">${esc(label)}</span>`:''}</a>`;
  const logo=(mark,label)=>`<span class="service-logo"><img src="../../../../../packages/brand/assets/marks/${mark}.svg" alt="${esc(label)}"></span>`;
  const serverLogo=s=>logo(s.id.startsWith('pve-')?'proxmox':s.id==='blackbox'?'unraid':'debian',s.id.startsWith('pve-')?'Proxmox':s.id==='blackbox'?'Unraid':'Debian');
  const serverHealth=s=>health(s.state,s.id==='blackbox'?'failed':s.id==='pve-02'?'warm':'');
  const normalTabs=(active='servers')=>`<nav class="tabs" aria-label="Overview sections">${[['servers','Servers',S.servers.length],['connections','Connections',5],['pinned','Pinned',1]].map(([id,label,total])=>`<a href="${url('overview',{section:id})}" ${id===active?'aria-current="page"':''}>${label}${hasSaved?`<span class="count">${total}</span>`:''}</a>`).join('')}</nav>`;
  function errorBlock(){
    const title=screen==='overview'?'Overview':screen==='server'?`${server.name}’s readings`:screen==='connection'?'Home Assistant’s page':'your automations';
    const fallback=screen==='overview'?'Showing saved readings. Each server keeps its own reading time.':screen==='server'?(server.reportAt?`Showing readings from ${clock(server.reportAt)} on 23 Sep.`:'Showing saved readings. Their reading time is unknown.'):screen==='connection'?'Showing the saved page. Its controls may have changed.':`Showing the list saved at ${clock(S.automationReadAt)} on ${date(S.automationReadAt)}.`;
    return `<section class="read-problem" role="status" aria-labelledby="read-error"><h2 id="read-error">Couldn’t ${state==='saved-failed'?'refresh':'read'} ${esc(title)}.</h2><p>${state==='saved-failed'?esc(fallback):'There’s no saved copy to show on this device yet.'}</p><div class="actions">${button('Try again',`data-retry aria-label="Try reading ${esc(title)} again"`,'primary')}${ask(`Could you help me read ${title}?`)}</div><details><summary aria-label="More detail about this failed read">More detail</summary><pre>${esc(`The ${screen} read did not complete. No new result was received.`)}</pre></details></section>`;
  }
  const loading=()=>`<p class="refreshing" role="status">Loading ${screen==='server'?'readings':screen==='connection'?'Home Assistant':screen==='automations'?'automations':'Overview'}…</p><div aria-hidden="true" class="skeleton-grid ${screen==='automations'?'skeleton-list':''}">${Array.from({length:screen==='automations'?3:4},()=>`<div class="skeleton"><i></i><i></i><span class="mini-tiles"><i></i><i></i><i></i></span></div>`).join('')}</div>`;
  function empty(){
    if(screen==='overview'&&q.get('section')==='pinned')return `<section class="empty"><h2>Nothing pinned yet</h2><p>Pin a chart from Chat to keep it here.</p><a class="button primary" href="${placeUrl('chat')}">Open Chat</a></section>`;
    const options={overview:['Nothing connected yet','Your servers, connections and pinned readings will appear here. Add a connection to get started.','Add a connection',`data-ask="Please help me add a connection."`],server:['No readings yet','This server’s readings will appear after its first report. Ask {assistant} to help connect it.','Ask {assistant}',`data-ask="Can you help ${server.name} report its readings?"`],connection:['No readings or controls yet','Once this connection reports, its controls and readings will appear here. Ask {assistant} to help connect it.','Ask {assistant}',`data-ask="Can you help me connect Home Assistant?"`],automations:['No automations yet','Repeated jobs and their results will appear here. Tell {assistant} what should happen on its own.','Tell {assistant}…','data-tell']};
    const [title,body,label,attrs]=options[screen].map(s=>s.replaceAll('{assistant}',esc(S.assistant)));
    return `<section class="empty"><span class="empty-mark" aria-hidden="true">${icon(screen==='server'?'overview':screen==='connection'?'settings':screen)}</span><h2>${title}</h2><p>${body}</p>${button(label,attrs,'primary')}</section>`;
  }
  function scope(content){return state==='loading'?loading():state==='empty'?empty():state==='failed'?errorBlock():`${state==='saved-failed'?errorBlock():state==='refreshing'?'<p class="refreshing" role="status">Refreshing…</p>':''}${content}`;}
  const figureLabel=key=>({cpu:'Processor',memory:'Memory',storage:'Storage',temp:'Temperature',hottest:'Temperature'}[key]||key);
  function meterShare(s,f){
    if(s.id==='pve-02')return {cpu:S.pve02.live.cpuPct/100,memory:S.pve02.live.memPct/100,storage:f.meter,hottest:71/85}[f.key];
    return ['temp','hottest'].includes(f.key)?Number(f.value)/85:Number(f.value)/100;
  }
  function blocks(s,f){
    const count=platform==='desktop'?20:10,share=meterShare(s,f),lit=Math.min(count,Math.max(share>0?1:0,Math.round(share*count)));
    return `<span class="block-bar" aria-hidden="true">${Array.from({length:count},(_,i)=>`<i${i<lit?' class="lit"':''}></i>`).join('')}</span>`;
  }
  function figures(s,links=false){return `<div class="figures ${s.id==='pve-02'?'pve-figures':''}">${s.figures.map(f=>{
    const label=f.label||figureLabel(f.key),chart={cpu:'cpu',memory:'memory',storage:'storage',temp:'temperatures',hottest:'temperatures'}[f.key];
    const detail=f.sub+(s.id==='pve-02'&&f.key==='memory'?' · 41 of 64 GB in use (64%) · includes reclaimable cache':s.id==='pve-02'&&f.key==='storage'?' · 31.8% in use':'');
    return `<${links?'a':'div'} class="figure" ${links?`href="${url('server',{server:s.id,tab:chart==='storage'?'storage':'history',chart})}" aria-label="${esc(label)}: ${esc(f.value)} ${esc(f.unit||'')}, ${esc(detail)}. See ${chart==='storage'?'storage':'reading history'}"`:''}><span class="figure-label">${esc(label)}${links?'<span aria-hidden="true"> ↗</span>':''}</span><strong>${esc(f.value)}${f.unit?` ${esc(f.unit)}`:''}</strong><small>${esc(detail)}</small>${blocks(s,f)}</${links?'a':'div'}>`;
  }).join('')}</div>`;}
  function serverCard(s){
    return `<a class="panel server-card" href="${url('server',{server:s.id})}"><div class="server-top"><span class="server-name">${serverLogo(s)}${esc(s.name)}</span>${serverHealth(s)}</div>${reading(s.reportAt)}${figures(s)}<span class="card-foot"><span>Open server readings</span><span aria-hidden="true">›</span></span></a>`;
  }
  function urgent(){const issue=S.inbox[0];return `<section class="urgent" aria-label="${esc(issue.title)}"><div><h2><a href="${placeUrl('inbox')}#${esc(issue.id)}">${esc(issue.title)}</a></h2><p>${esc(issue.body)}.</p></div>${button(esc(issue.actions[0].label),`data-ask="${esc(issue.title)}. Can you look into it?"`,'primary')}</section><a class="other-inbox" href="${placeUrl('inbox')}">${S.inbox.length-1} other things need you <span aria-hidden="true">›</span></a>`;}
  function lineChart(points,series,{label,lastAt}={}){
    const width=800,height=230,pad=18,values=points.flatMap(p=>series.map(s=>p.values[s.key])).filter(v=>v!=null),max=Math.max(...values,1)*1.1;
    const x=i=>pad+i/(points.length-1)*(width-2*pad),y=v=>height-pad-v/max*(height-2*pad);
    const paths=series.map((line,index)=>`<path class="chart-line line-${index}" d="${points.map((p,i)=>p.values[line.key]==null?'':`${i?'L':'M'}${x(i).toFixed(2)} ${y(p.values[line.key]).toFixed(2)}`).join(' ')}"/>`).join('');
    return `<figure class="reading-chart" role="group" aria-label="${esc(label)}"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}. Last point ${clock(lastAt)} on ${date(lastAt)}."><path class="chart-grid" d="M18 58H782M18 115H782M18 172H782"/>${paths}${series.map((line,i)=>`<circle class="chart-point line-${i}" cx="${x(points.length-1)}" cy="${y(points.at(-1).values[line.key])}" r="4"/>`).join('')}</svg><figcaption class="chart-times"><span>${date(points[0].t)}, ${clock(points[0].t)}</span><span><time datetime="${lastAt}">${Math.floor((Date.parse(S.frozen)-Date.parse(lastAt))/60000)} min ago</time><small>${clock(lastAt)}</small></span></figcaption></figure>`;
  }
  function pinned(){
    const widget=F.widget,last=widget.points.at(-1).t;
    const failure=state==='saved-failed'?`<section class="read-problem pinned-error" role="status"><h2>Couldn’t refresh; showing readings from ${clock(last)} on ${date(last)}.</h2><p>The chart and figures below keep their last readings.</p><div class="actions">${button('Try again','data-retry','primary')}${ask('Could you help me refresh Power use?')}</div></section>`:'';
    return `${failure}<section class="panel pinned-widget"><div class="server-top"><h2>${esc(widget.title)}</h2><a class="widget-source" href="${url('connection')}">${logo('homeassistant','Home Assistant')}Home Assistant <span aria-hidden="true">›</span></a></div><p class="small widget-range">Last 24 hours · ${reading(last)}</p><div class="chart-legend">${widget.series.map((line,i)=>`<span><i class="legend-${i}" aria-hidden="true"></i>${esc(line.label)} <strong>${widget.latest.find(v=>v.key===line.key).value} kW</strong></span>`).join('')}</div>${lineChart(widget.points,widget.series,{label:'House and heat pump power use, in kilowatts, over the last 24 hours',lastAt:last})}<div class="actions widget-actions"><a class="button" href="${placeUrl('chat')}">Open in Chat</a>${button('Unpin','data-preview="Unpin removes this widget from Pinned. It keeps its original in Chat."')}</div></section>`;
  }
  function connectionCards(){
    return `<div class="server-grid connection-grid">${F.connections.map(c=>{
      const ha=c.name==='Home Assistant',learning=c.kind==='device',mark=ha?'homeassistant':c.name==='UniFi'?'unifi_network':c.name==='Mail'?'gmail':'hetzner';
      const status=ha?S.connection.state:learning?'Learning':'Connected',reason=ha?'4 things need a look.':learning?`${S.assistant} is learning what it can do. It reads fine already.`:'';
      const facts=ha?[{label:'Integrations',value:'102'}]:learning?[]:c.facts;
      return `<a class="panel connection-card" href="${ha?url('connection'):url('connection',{connection:c.name})}" ${ha?'':`data-preview="${esc(c.name)} keeps its existing page in the app."`}><div class="server-top"><span class="server-name">${learning?`<span class="service-logo device-logo">${icon('settings')}</span>`:logo(mark,c.name)}${esc(c.name)}</span>${health(status,ha?'warm':learning?'learning':'')}</div>${reason?`<p class="card-summary">${esc(reason)}</p>`:''}${facts.length?`<dl class="connection-facts">${facts.map(f=>`<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}${f.unit?' '+esc(f.unit):''}${f.note?' · '+esc(f.note):''}</dd></div>`).join('')}</dl>`:''}${c.usedAt&&new Date(c.usedAt).toDateString()===new Date(S.frozen).toDateString()?'<p class="small used-at">Used today</p>':''}</a>`;
    }).join('')}</div>`;
  }
  function overview(){
    const section=['servers','connections','pinned'].includes(q.get('section'))?q.get('section'):'servers';
    const header=heading('Overview','',button('Add a connection','data-ask="Please help me add a connection."'));
    const content=section==='pinned'?`<div id="pinned-readings">${pinned()}</div>`:section==='connections'?connectionCards():`<div class="server-grid">${S.servers.map(serverCard).join('')}</div>`;
    const alternative=section==='pinned'&&state==='saved-failed'?content:scope(content);
    return {header,content:`<div class="body">${hasSaved?urgent():''}${normalTabs(section)}${alternative}</div>`};
  }
  function serverPage(){
    const isPve=server.id==='pve-02',isBroken=server.id==='blackbox';
    const sub=`<div class="status-line">${hasSaved?serverHealth(server):''}${hasSaved?reading(server.reportAt):state==='empty'?reading(null):''}</div>`;
    const header=heading(server.name,sub,hasSaved?ask(`Can you help me with ${server.name}?`):'',back('Overview',url('overview'))).replace('<h1 tabindex="-1">',`<h1 tabindex="-1">${serverLogo(server)}`);
    const problem=isPve?`<section class="panel notice"><h2>${esc(S.pve02.notices[0].title)}</h2><p>${esc(S.pve02.notices[0].detail)}</p>${ask(S.pve02.notices[0].link.question)}</section>`:isBroken?`<section class="panel notice not-working"><h2>${esc(S.inbox[0].title)}</h2><p>${esc(S.inbox[0].body)}.</p>${button('Look into it',`data-ask="${esc(S.inbox[0].title)}. Can you look into it?"`,'primary')}</section>`:'';
    const details=`<section class="panel server-summary">${figures(server,true)}<a class="history-link" href="${url('server',{server:server.id,tab:'history'})}">See reading history <span aria-hidden="true">›</span></a></section>`;
    const technical=isPve?`<details class="panel" id="technical"><summary>Technical facts</summary><dl class="facts"><dt>System</dt><dd>${esc(S.pve02.server.os.name)} ${esc(S.pve02.server.os.version)}</dd><dt>Processor</dt><dd>${esc(S.pve02.server.cpu.model)} · ${S.pve02.server.cpu.cores} cores / ${S.pve02.server.cpu.threads} threads</dd><dt>Memory</dt><dd>${S.pve02.server.memory.totalGb} GB ${S.pve02.server.memory.type}</dd><dt>Address</dt><dd>${esc(S.pve02.server.address)}</dd></dl></details><details class="panel" id="heads-ups"><summary>Show 1 heads-up</summary><div class="notice-row"><div><h3>${esc(S.pve02.notices[1].title)}</h3><p>${esc(S.pve02.notices[1].detail)}</p></div>${button('See updates','data-preview="The existing updates tab opens here in the app."')}</div></details><section class="panel related"><h2>In Chat</h2><a href="${placeUrl('chat',{thread:'msg_chat-memory'})}">Why is pve-02 using so much memory?${health('Waiting for you','warm')}</a></section>`:'';
    const tab=q.get('tab')||'summary';
    const names=platform==='desktop'?['Summary','Machines','Storage','Sensors','Backups','System']:server.id==='blackbox'?['Summary','Array','Apps','Plugins']:server.id==='the-falcon'?['Summary','Machines']:['Summary','Machines','Backups'];
    const tabs=`<nav class="tabs server-tabs" aria-label="${esc(server.name)} sections">${names.map(label=>`<a href="${url('server',{server:server.id,tab:label.toLowerCase()})}" ${tab===label.toLowerCase()?'aria-current="page"':''}>${label}</a>`).join('')}</nav>`;
    let content=problem+details+technical;
    if(tab==='history'){
      const chart=F.charts.find(c=>c.id===(q.get('chart')||'cpu'))||F.charts[0];
      const points=chart.timestamps.map((t,i)=>({t,values:Object.fromEntries(chart.series.map(line=>[line.key,line.values[i]]))}));
      content=`<a class="back" href="${url('server',{server:server.id})}">← Summary</a><section class="panel"><h2>${esc(chart.title)} · reading history</h2><p class="subtitle">Last 24 hours · ${reading(server.reportAt)}</p>${isPve?lineChart(points,chart.series,{label:chart.title+' history',lastAt:points.at(-1).t}):'<p class="subtitle">No saved history is available for this server in this drawing.</p>'}</section>`;
    }else if(tab==='machines')content=`<section class="panel"><h2>Machines</h2>${isPve?`<ul class="machine-list">${F.machines.filter(m=>!m.name.startsWith('ci-job-')&&!m.name.startsWith('agent-')).slice(0,10).map(m=>`<li><a href="#" data-preview="${esc(m.name)} keeps its existing machine page.">${esc(m.name)} <span aria-hidden="true">›</span></a></li>`).join('')}</ul><p class="small">Temporary machines stay hidden.</p>`:'<p class="subtitle">The existing list of machines opens here in the app.</p>'}</section>`;
    else if(tab==='backups')content=`<section class="panel"><h2>Backups</h2><p class="subtitle">${isPve?esc(F.backups.empty):'The existing backups page stays here.'}</p>${ask(`Can you help me set up backups for ${server.name}?`)}</section>`;
    else if(tab!=='summary')content=`<section class="panel"><h2>${esc(tab.charAt(0).toUpperCase()+tab.slice(1))}</h2><p class="subtitle">The existing ${esc(tab)} page stays here.</p><a class="history-link" href="${url('server',{server:server.id,tab:'summary'})}">Back to Summary</a></section>`;
    return {header,content:`<div class="body">${tabs}${scope(content)}</div>`};
  }
  const problems=[['Disk full in about 2 months','8.7 GB is old backups','Ask {assistant}'],['Modbus fills the log','92 % of 12,286 errors, still coming in','Show them'],['2 integrations not loading','Shelly pool pump, garage door','Ask {assistant}'],['3 HomeWizard meters need a new sign-in','Zwembad Techniek, Schuilstal, WTW Zolder','Repair']];
  const heads=[['Home Assistant has an update','Two fixes for Modbus','Ask {assistant}','Should I update Home Assistant?'],['The database grows 110 MB a day','sensor.evcs_* writes every second','Ask {assistant}','Why does Home Assistant’s database grow so fast?'],['2 sensors have a low battery','Hallway motion, Back door'],['Its own backups are 7 months old','Proxmox backs up the whole machine instead'],['An automation ran 212 times today','Garden lights at dusk','Ask {assistant}','Why did Garden lights at dusk run 212 times today?']];
  const words=v=>v.replaceAll('{assistant}',S.assistant);
  function noticeRows(rows,actions=false){return rows.map(([title,detail,label,question])=>`<div class="notice-row"><div><h3>${esc(title)}</h3><p>${esc(detail)}</p></div>${actions&&label?button(esc(words(label)),label.includes('{assistant}')?`data-ask="${esc(question||title+'. Can you look into it?')}" aria-label="Ask ${esc(S.assistant)} about ${esc(title)}"`:`data-preview="${esc(label==='Repair'?'The existing Home Assistant repairs page opens; no repair has been applied.':'The existing Home Assistant log opens here.')}" aria-label="${esc(label)}: ${esc(title)}"`):''}</div>`).join('');}
  function toggle(label,on,sub=''){return `<button type="button" class="control-tile ${on?'lit':''}" role="switch" aria-checked="${on}" aria-label="${label}" data-control="${label}"><span class="control-top">${icon('settings')}<span class="switch" aria-hidden="true"><i></i></span></span><strong>${label}</strong><span class="control-state">${on?'On':'Off'}${sub?' · '+sub:''}</span></button>`;}
  function connection(){
    const sub=hasSaved?`<div class="status-line">${health(S.connection.state,'warm')}</div><div class="page-facts"><a class="host-link" href="${url('server')}">Runs on homeassistant (pve-02) ›</a>${button('10.100.0.131:8123 ⧉','aria-label="Copy the address 10.100.0.131:8123" data-copy','address')}</div><details><summary>More detail</summary><p>Home Assistant · 102 integrations</p></details><div class="actions connection-actions">${ask('Can you help me with Home Assistant?','primary')}${button('Open','data-preview="Open Home Assistant in its own page." aria-label="Open Home Assistant"')}</div>`:'';
    const header=heading('Home Assistant',sub,'',back('Overview',url('overview',{section:'connections'}))).replace('<h1 tabindex="-1">',`<h1 tabindex="-1">${logo('homeassistant','Home Assistant')}`);
    const content=`<nav class="tabs" aria-label="Home Assistant sections">${['Summary','Integrations 102','Log','Connection'].map((t,i)=>`<a href="#${i===0?'controls':'more'}" ${i===0?'aria-current="page"':'data-preview="Open the existing Home Assistant '+t+' tab."'}>${t}</a>`).join('')}</nav><section class="panel problem-list"><h2>Worth a look</h2>${noticeRows(problems,true)}<details class="heads-ups" id="heads-ups"><summary>Show 5 heads-ups</summary>${noticeRows(heads,true)}</details></section><section class="panel" id="controls"><h2>Controls <span class="small">Your favourites</span></h2><p class="small" style="margin:16px 0">Living room</p><div class="controls-grid">${toggle('Ceiling light',true,'80%')}${toggle('Floor lamp',false)}<section class="control-tile"><span>${icon('automations')}</span><strong>Movie night</strong>${button('Activate','data-preview="Movie night has not been activated in this drawing." aria-label="Activate Movie night"')}</section><section class="control-tile lit thermostat"><strong>Thermostat</strong><span class="control-state">20.8 °C now · heating</span><b>21.5 °C</b><div class="stepper">${button('−','aria-label="Lower Thermostat" data-control="Thermostat"')}${button('+','aria-label="Raise Thermostat" data-control="Thermostat"')}</div></section></div><p class="small" style="margin:20px 0 14px">Hall and garden</p><div class="controls-grid">${toggle('Hall light',true)}<section class="control-tile"><strong>Front door</strong><span class="control-state">Locked</span>${button('Unlock','data-unlock aria-label="Unlock Front door"')}</section></div></section>`;
    return {header,content:`<div class="body">${scope(content)}</div>`};
  }
  const enabled=a=>a.status==='published'?'On':a.status==='disabled'?'Off':'Not on yet';
  const result=r=>r.status==='succeeded'?'worked':r.status==='failed'?'failed':r.status==='skipped'?'skipped':r.status==='waiting'?'Waiting for you':r.status==='cancelled'?'stopped':r.status;
  const lastLine=a=>!a.lastRun?'No runs yet':a.lastRun.finishedAt?`Last run ${result(a.lastRun)} · ${stamp(a.lastRun.finishedAt)}`:`Last run · ${result(a.lastRun)} · started ${stamp(a.lastRun.startedAt)}`;
  function nextLine(a){return a.status==='disabled'?'Next run · Off':a.status==='draft'?'Next run · Not on yet':a.nextRunAt?`Next run · ${stamp(a.nextRunAt)}`:a.glance.source==='message'?'Next run · On the next matching message':a.glance.source==='tracker'?'Next run · On a new report or customer reply':a.id==='aut_assess-billing'?'Next run · On a new issue or pull request':'Next run · On a new issue';}
  const planLine=a=>a.waitingPlanId?S.automationRows.find(r=>r.id===a.id).state.line:'';
  function autoRow(a){
    return `<article class="auto-row"><span class="auto-mark" aria-hidden="true">${icon('automations')}</span><div class="auto-body"><div class="auto-title"><a href="${url('automations',{view:'detail',automation:a.id})}">${esc(a.name)}</a></div><p class="trigger">${esc(a.triggerSummary)}</p><p><span class="auto-state">${enabled(a)}</span></p><p class="last">${a.lastRun?`<a href="${url('automations',{view:'run',automation:a.id,run:a.lastRun.id})}">${esc(lastLine(a))} ›</a>`:'No runs yet'}</p><p>${esc(nextLine(a))}</p>${planLine(a)?`<p class="waiting">${esc(planLine(a))}</p>`:''}<span class="run-bars" aria-hidden="true">${[...a.recentRuns].slice(0,5).reverse().map(r=>`<i class="${r.status}"></i>`).join('')}</span></div><a class="button icon-button" href="${url('automations',{view:'detail',automation:a.id})}" aria-label="Open ${esc(a.name)}">›</a></article>`;
  }
  function schedules(){return `<div class="section-title"><h2>Only tells you</h2></div>${S.schedules.map(s=>`<section class="panel schedule"><h3>${esc(s.what)}</h3><p>${esc(s.when)}</p><p>${s.next?'Next run · '+esc(s.next.value):'Next run · Paused'}</p><details><summary>Schedule details</summary>${s.facts.filter(f=>f.label!=='Next').map(f=>`<p>${esc(f.label)} · ${esc(f.value)}</p>`).join('')}</details><div class="actions">${s.actions.map(a=>button(a==='pause'?'Pause':a==='resume'?'Resume':'Remove',`data-preview="The existing ${a} action for this schedule is available in the app. This drawing does not change it."`)).join('')}</div></section>`).join('')}`;}
  function composer(){return `<div class="composer"><label class="sr-only" for="automation-request">Tell ${esc(S.assistant)} what should happen on its own</label><textarea id="automation-request" rows="1" placeholder="Tell ${esc(S.assistant)} what should happen on its own…"></textarea>${button(icon('file'),'aria-label="Attach a file" data-preview="Attach a file to the automation request in Chat."')}${button(icon('mic'),'aria-label="Voice typing" data-preview="Voice typing opens in the app."')}${button(icon('send'),'aria-label="Send automation request" data-tell','send')}</div>`;}
  function automations(){
    if(view==='run'&&run){
      const header=heading(`Run #${run.number}`,'','',back('Automation',url('automations',{view:'detail',automation:automation.id})));
      const label=run.finishedAt?`Finished · ${result(run)}`:result(run);
      return {header,content:`<div class="body"><section class="panel"><span class="run-result ${run.status==='failed'?'failed':''}">${label}</span><strong class="run-automation">${esc(automation.name)}</strong><dl class="facts"><dt>Started</dt><dd>${stamp(run.startedAt)} · 2026</dd>${run.finishedAt?`<dt>Finished</dt><dd>${stamp(run.finishedAt)} · 2026</dd>`:''}<dt>Time zone</dt><dd>Europe/Amsterdam</dd></dl>${run.status==='waiting'?'<p class="waiting">This run is waiting for a yes.</p>':''}<details><summary>More detail</summary><p>Run #${run.number} · ${esc(run.id)}</p><p>Recorded result: ${esc(run.status)}</p></details></section></div>`};
    }
    if(view==='detail'){
      const header=heading(automation.name,`<div class="status-line"><span class="auto-state">${enabled(automation)}</span></div>`,'',back('Automations',url('automations')));
      return {header,content:`<div class="body"><section class="panel"><p class="subtitle">${esc(automation.triggerSummary)}</p><p class="subtitle">${esc(lastLine(automation))}</p><p class="subtitle">${esc(nextLine(automation))}</p>${planLine(automation)?`<p class="subtitle waiting">${esc(planLine(automation))}</p>`:''}</section><h2 class="section-title">Recent runs</h2><section class="panel run-list">${automation.recentRuns.map(r=>`<a href="${url('automations',{view:'run',automation:automation.id,run:r.id})}"><span>Run #${r.number} · ${result(r)}</span><span>${stamp(r.finishedAt||r.startedAt)} ›</span></a>`).join('')||'<p>No runs yet</p>'}</section></div>`};
    }
    const header=heading('Automations','<p class="subtitle">What '+esc(S.assistant)+' does on its own.</p>');
    const content=`<div class="list-intro"><p class="subtitle">To make one or change one, tell ${esc(S.assistant)}.</p>${composer()}</div><div class="section-title"><h2>Automations <span class="small">${S.automations.length}</span></h2></div><section class="panel auto-list">${S.automations.map(autoRow).join('')}</section>${schedules()}`;
    return {header,content:`<div class="body">${scope(content)}</div>`};
  }
  const drawn=({overview,server:serverPage,connection,automations}[screen])();
  Shell.mount({platform,theme,active:screen==='automations'?'automations':'overview',title:name,header:drawn.header,content:drawn.content,hideTabs:native&&(screen==='server'||screen==='connection'||view!=='list')});
  for(const a of document.querySelectorAll('[data-place="overview"],[data-place="automations"]'))a.href=url(a.dataset.place);
  // Show the selected alternative, without pretending it changes the shared snapshot.
  const main=document.querySelector('#main');
  if(q.get('expand')==='all')document.querySelectorAll('main details,.screen-head details').forEach(d=>d.open=true);
  if(q.get('focus')==='pinned')document.getElementById('pinned-readings')?.scrollIntoView();
  if(q.get('focus')==='controls')document.getElementById('controls')?.scrollIntoView();
  if(q.get('focus')==='later')main.scrollTop=main.scrollHeight-main.clientHeight;
  const dialog=document.createElement('dialog');dialog.className='action-dialog';dialog.setAttribute('aria-labelledby','dialog-title');document.body.append(dialog);
  let opener;
  function openDialog(title,body,field=false){dialog.innerHTML=`<h2 id="dialog-title">${esc(title)}</h2>${field?`<label class="sr-only" for="question">Question for ${esc(S.assistant)}</label><textarea id="question">${esc(body)}</textarea><p>This question is ready to send in Chat.</p>`:`<p>${esc(body)}</p>`}<div class="actions">${button('Close','data-close-dialog')}</div>`;dialog.showModal();(dialog.querySelector('textarea')||dialog.querySelector('button')).focus();}
  document.addEventListener('click',e=>{
    const target=e.target.closest('button,a');if(!target)return;
    if(target.hasAttribute('data-ask')){e.preventDefault();if(!dialog.open)opener=target;openDialog(`Ask ${S.assistant}`,target.dataset.ask,true);}
    if(target.hasAttribute('data-preview')||target.hasAttribute('data-control')){e.preventDefault();if(!dialog.open)opener=target;openDialog('Design preview',target.dataset.preview||`${target.dataset.control} keeps the saved state in this drawing.`);}
    if(target.hasAttribute('data-retry')){opener=target;target.textContent='Refreshing…';target.setAttribute('aria-disabled','true');target.closest('.read-problem').querySelector('h2').textContent='Refreshing…';}
    if(target.hasAttribute('data-tell')){if(!dialog.open)opener=target;openDialog(`Tell ${S.assistant}`,document.getElementById('automation-request')?.value||'What should happen on its own?',true);}
    if(target.hasAttribute('data-copy')){if(!dialog.open)opener=target;openDialog('Address', '10.100.0.131:8123');}
    if(target.hasAttribute('data-unlock')){if(!dialog.open)opener=target;openDialog('Unlock the front door?','Anyone at the door can come in.');dialog.querySelector('.actions').insertAdjacentHTML('afterbegin',button('Cancel','data-close-dialog')+button('Unlock','data-preview="The door stays locked in this drawing. In the app, this confirmation sends one unlock request."','primary'));}
    if(target.hasAttribute('data-close-dialog'))dialog.close();
  });
  dialog.addEventListener('close',()=>opener?.focus({preventScroll:true}));
})();
