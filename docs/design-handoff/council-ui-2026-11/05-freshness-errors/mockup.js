// Static review scenarios. No network calls, command sends, timers or live sorting.
const query = new URLSearchParams(location.search);
const screen = ['overview', 'pinned', 'server', 'automations'].includes(query.get('screen')) ? query.get('screen') : 'pinned';
const state = query.get('state') || (screen === 'automations' ? 'normal' : 'read');
const platform = query.get('platform') || 'web';
const theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const keep = query.get('variant') === 'keep';
const assistant = REVIEW_FIXTURE.assistant;
const native = platform !== 'web';
document.documentElement.dataset.theme = theme;
document.body.classList.toggle('native', native);
document.body.classList.add(platform);
if (query.get('text') === 'large') document.documentElement.classList.add('largest');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const icons = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  inbox: '<path d="M4 4h16l2 12v4H2v-4zM2 14h6l2 3h4l2-3h6"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  automations: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  vault: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 5 3 2 1 3 5 4 2-3 3-1 4-5-3-2-1-3z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  arrow: '<path d="M19 12H5m7-7-7 7 7 7"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="m16 3 5 5-4 1-4 4v4l-3-3-6 6 6-6-3-3h4l4-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  file: '<path d="m21 11-9 9a5 5 0 0 1-7-7L15 3a3 3 0 0 1 4 4L9 17a1 1 0 0 1-2-2l9-9"/>',
  signal: '<path d="M3 20v-4m5 4v-8m5 8V8m5 12V4"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.server}</svg>`;
const href = (page, extra = '') => `mockup.html?screen=${page}&platform=${platform}&theme=${theme}${extra}`;
const button = (label, action, primary = false) => `<button type="button" data-preview="${esc(action)}" class="${primary ? 'primary' : ''}">${label}</button>`;
const ask = (suffix = '') => button(`Ask ${esc(assistant)}${suffix}`, suffix ? `Check what happened before making another change. The mockup would open the existing conversation about pve-02 with a question asking ${assistant} to check whether the restart happened. It does not send another restart.` : `The mockup would open the conversation about this page with a question for ${assistant}.`);

function sidebar() {
  const links = [['chat', 'Chat'], ['inbox', 'Inbox'], ['overview', 'Overview'], ['automations', 'Automations'], ['vault', 'Vault']];
  return `<aside class="sidebar" aria-label="Sidebar"><a class="brand" href="index.html"><img alt="" src="../../../../apps/web/public/favicon.svg">Burrow HQ</a><nav aria-label="Whombat">${links.map(([id, label]) => `<a href="${href(id === 'automations' ? id : 'overview')}" ${id === (screen === 'automations' ? 'automations' : screen !== 'server' ? 'overview' : '') ? 'aria-current="page"' : ''}>${icon(id)}${label}</a>`).join('')}</nav><div class="server-nav"><div class="eyebrow">Servers &nbsp; Connections</div>${['thetitan', 'pve-01', 'pve-02', 'blackbox', 'the-falcon'].map(name => `<a href="${href('server')}" ${screen === 'server' && name === 'pve-02' ? 'aria-current="page"' : ''}>${icon('server')}${name}${name === 'pve-02' ? '<i class="dot" aria-label="Needs a look"></i>' : name === 'blackbox' ? '<i class="dot broken" aria-label="Not working"></i>' : ''}</a>`).join('')}<a href="${href('overview')}">${icon('overview')}Home Assistant<i class="dot" aria-label="Needs a look"></i></a><a href="${href('overview')}">${icon('overview')}UniFi<i class="dot" aria-label="Needs a look"></i></a></div><div class="account"><span class="human" aria-hidden="true">MO</span><span><b>Mara Okafor</b><br><span class="muted">Settings</span></span></div></aside>`;
}
function tabBar() {
  return `<nav class="tab-bar" aria-label="Main tabs">${[['chat','Chat'],['inbox','Inbox'],['overview','Overview'],['automations','Automations'],['settings','Settings']].map(([id,label]) => `<a href="${href(id === 'automations' ? id : 'overview')}" ${id === (screen === 'automations' ? 'automations' : 'overview') ? 'aria-current="page"' : ''}>${icon(id)}<span>${label}</span></a>`).join('')}</nav>`;
}
function errorBlock(kind = 'read', scope = screen, noData = false) {
  const names = { overview: 'Overview', pinned: 'the heat pump readings', server: 'the readings for pve-02', automations: 'the automations' };
  const fallback = { overview: 'Showing the last Overview saved on this device.', pinned: 'Showing readings from 11:10.', server: 'Showing the last saved readings for pve-02.', automations: 'Showing the last automations list saved on this device.' };
  let title = `Couldn’t ${scope === 'overview' || scope === 'pinned' ? 'refresh' : 'read'} ${names[scope]}.`;
  let copy = noData ? 'There’s no saved copy to show on this device yet.' : fallback[scope];
  let controls = button('Try again', 'This would repeat only the failed read. During the request, older values stay in place and the status says Refreshing.') + ask();
  let raw = `No route for GET /api/v1/burrows/bur_fixture/${scope === 'server' ? 'hosts/servers/pve-02' : scope === 'automations' ? 'automations' : 'home'}`;
  if (kind === 'action') {
    title = 'The restart may have happened.';
    copy = 'Whombat didn’t get an answer from pve-02. Check what happened before starting another restart.';
    controls = ask(' to check');
    raw = 'unknown_outcome · The command may have acted; its answer was not recorded.';
  } else if (kind === 'completed') {
    title = 'The change was saved. Its reply isn’t available.';
    copy = 'Check pve-02 to see the result before making another change.';
    controls = ask(' to check');
    raw = 'outcome: completed · redacted: true';
  } else if (kind === 'refused') {
    title = 'The restart wasn’t started.';
    copy = 'pve-02 is unavailable. Check its connection before starting a new request.';
    controls = ask(' to check');
    raw = 'receipt: not_executed · Runner did not take the request.';
  }
  return `<section class="notice" aria-labelledby="error-title" role="status">${icon('info')}<div><h2 id="error-title">${title}</h2><p>${copy}</p><div class="actions">${controls}</div><details ${query.get('detail') === 'open' ? 'open' : ''}><summary>More detail</summary><pre>${esc(raw)}</pre></details></div></section>`;
}
function refreshLine() { return `<p class="refresh-line" role="status">${icon('refresh')}Refreshing<span aria-hidden="true">·</span>Keeping the last saved values in view.</p>`; }
function tabs(pinned = false) { return `<nav class="tabs" aria-label="Overview"><a href="${href('overview')}" ${!pinned ? 'aria-current="page"' : ''}>Servers ${state === 'loading' ? '' : '<small>5</small>'}</a><a href="${href('overview')}">Connections ${state === 'loading' ? '' : '<small>5</small>'}</a><a href="${href('pinned')}" ${pinned ? 'aria-current="page"' : ''}>Pinned ${state === 'loading' ? '' : '<small>1</small>'}</a></nav>`; }
function heading(title, subtitle) { if (title === 'Overview' && !['empty','loading'].includes(state)) subtitle = `<a href="#inbox" class="bad" data-preview="This would open the existing Inbox item for blackbox.">The disk array on blackbox has failed.</a> ${REVIEW_FIXTURE.summary.needsYou - 1} other things need you. ${button(`Ask ${assistant} to handle it`, 'This would use the existing handle action for the blackbox Inbox item.')}`; return `<header class="title-row"><div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${title === 'Overview' && state !== 'empty' ? button(`${icon('plus')}Add a connection`, 'This would open the existing Add a connection page.') : ''}</header>`; }
function serverCard(name, os, values, broken = false, warm = false) {
  const labels = ['CPU','Memory','Storage','Temp'];
  return `<article class="panel server-card"><div class="server-head"><div class="tile">${icon('server')}</div><div class="head-copy"><h2>${name}</h2><p class="muted">${os}</p>${native ? `<span class="pill ${warm ? 'warn' : broken ? 'bad' : 'ok'}"><i class="dot ${broken ? 'broken' : warm ? '' : 'green'}" aria-hidden="true"></i>${broken ? 'Disk array failed' : warm ? 'Running hot' : 'Running'}</span>` : ''}</div>${native ? '' : `<span class="pill ${warm ? 'warn' : broken ? 'bad' : 'ok'}"><i class="dot ${broken ? 'broken' : warm ? '' : 'green'}" aria-hidden="true"></i>${broken ? 'Disk array failed' : warm ? 'Running hot' : 'Running'}</span>`}</div><p class="hardware">${name === 'blackbox' ? 'Xeon W-1250' : name === 'pve-02' ? 'Ryzen AI MAX+ PRO' : 'Core i9-13900H'}</p><div class="figures">${values.map((v, i) => `<div class="figure"><span class="eyebrow">${labels[i]}</span><strong class="${warm && i === 3 ? 'warn' : ''}">${v}<small>${i === 3 ? ' °C' : ' %'}</small></strong><div class="meter" aria-hidden="true"><i style="width:${Math.min(100,v)}%"></i></div><small>${i === 0 ? '24 h average' : i === 1 ? 'in use' : i === 2 ? 'used' : 'last reading'}</small></div>`).join('')}</div><p class="server-foot">${name === 'blackbox' ? '13 of 21' : name === 'pve-02' ? '19 of 23' : '1 of 35'} machines running</p></article>`;
}
function loading(scope) {
  const cards = scope === 'overview' ? `<div class="grid">${[0,1,2,3].map(() => `<div class="panel pad"><div class="skeleton title"></div><div class="skeleton small"></div><div class="figures">${[0,1,2,3].map(() => '<div class="figure"><div class="skeleton small"></div><div class="skeleton title"></div></div>').join('')}</div></div>`).join('')}</div>` : scope === 'automations' ? `<div class="panel">${[0,1,2].map(() => '<div class="skeleton-row"><div class="tile"></div><div class="skeleton-body"><div class="skeleton title"></div><div class="skeleton"></div><div class="skeleton small"></div></div></div>').join('')}</div>` : `<div class="panel metric-strip">${[0,1,2,3].map(() => '<div class="metric"><div class="skeleton small"></div><div class="skeleton title"></div><div class="skeleton graph"></div></div>').join('')}</div><div class="server-columns"><div class="panel">${[0,1,2].map(() => '<div class="skeleton-row"><div class="skeleton-body"><div class="skeleton"></div><div class="skeleton small"></div></div></div>').join('')}</div><div class="stack"><div class="panel pad"><div class="skeleton title"></div><div class="skeleton"></div></div><div class="panel pad"><div class="skeleton title"></div><div class="skeleton"></div></div></div></div>`;
  return `<div role="status" aria-label="Loading ${scope === 'server' ? 'pve-02' : scope === 'automations' ? 'automations' : 'Overview'}"><p class="loading-label">${icon('clock')}Loading ${scope === 'server' ? 'pve-02' : scope === 'automations' ? 'automations' : 'Overview'}…</p><div aria-hidden="true">${cards}</div></div>`;
}
function empty(scope) {
  const content = {
    overview: ['Your servers and connections will appear here.', `Connect a server or a service to see its readings. You can also ask ${assistant} to help you set it up.`, button('Add a connection', 'This would open the existing Add a connection page.', true)],
    pinned: ['The readings you pin will appear here.', `Ask ${assistant} for a chart in Chat, then pin it to Overview.`, button('Open Chat', 'This would open Chat, where charts can be pinned.', true)],
    server: ['No readings from pve-02 yet.', `Its readings and machines will appear after its first report. Ask ${assistant} to check the connection if you’re waiting.`, ask(' to check')],
    machines: ['No machines here yet.', `Machines added on pve-02 will appear here. Ask ${assistant} to help you add one.`, button(`Ask ${assistant} to add a machine`, 'This would start a conversation about adding a machine. Any change still follows its approval rules.')],
    automations: ['What runs on its own will appear here.', `Tell ${assistant} what you’d like to happen and when. You’ll review its plan in Chat before it starts.`, button('Describe an automation', 'This focuses the Automations field above, where a request starts its plan in Chat.', true)],
  }[scope];
  return `<section class="panel empty"><div class="tile">${icon(scope === 'automations' ? 'automations' : scope === 'pinned' ? 'pin' : 'server')}</div><h2>${content[0]}</h2><p>${content[1]}</p><div class="actions">${content[2]}</div></section>`;
}
function overview() {
  return heading('Overview', state === 'empty' || state === 'loading' ? '' : 'Your servers and connections, at a glance.') + (state === 'loading' ? loading('overview') : state === 'empty' ? empty('overview') : `${tabs()}${state === 'read' ? errorBlock() : state === 'no-copy' ? errorBlock('read','overview',true) : state === 'refreshing' ? refreshLine() : ''}${state === 'no-copy' ? '' : `<div class="grid">${serverCard('blackbox','Unraid 7.3 · up 96 d',[11,22,59,61],true)}${serverCard('pve-02','Proxmox VE 9.2 · up 23 d',[10,64,44,75],false,true)}${serverCard('pve-01','Proxmox VE 9.2 · up 23 d',[1,3,20,51])}${serverCard('the-falcon','Debian 13 · up 9 d',[1,15,30,65])}</div>`}`);
}
function widgetPlot() {
  const w = REVIEW_FIXTURE.widget;
  const width = 1000, height = 200;
  return `<div class="chart" role="img" aria-label="Heat pump readings. Latest point 11:10, 12 minutes ago. Room 21 degrees Celsius, water to radiators 34 degrees Celsius, outside 9 degrees Celsius."><div class="plot"><div class="yaxis" aria-hidden="true">${[50,40,30,20,10,0].map(v => `<span>${v}°</span>`).join('')}</div><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${[0,40,80,120,160,200].map(y => `<path d="M0 ${y}H${width}" stroke="var(--line)"/>`).join('')}${w.series.map((s,i) => `<polyline points="${w.points.map((p,n) => `${n/(w.points.length-1)*width},${height-p.values[s.key]/50*height}`).join(' ')}" fill="none" stroke="var(--chart${i+1})" stroke-width="2" vector-effect="non-scaling-stroke"/><circle cx="${width}" cy="${height-w.latest[i].value/50*height}" r="3" fill="var(--chart${i+1})"/>`).join('')}</svg></div><div class="axis" aria-hidden="true"><span>00:00</span><span>04:00</span><span>08:00</span><span class="last-point">12 min ago</span></div></div>`;
}
function pinned() {
  return heading('Overview', 'Your servers and connections, at a glance.') + tabs(true) + (state === 'empty' ? empty('pinned') : state === 'loading' ? loading('overview') : `<section class="panel pad"><div class="widget-head"><div><h2>Heat pump · today</h2><span class="muted">Daikin Altherma</span></div>${button('Open', 'This would open the existing conversation from which the chart was pinned.')}</div><dl class="widget-values">${REVIEW_FIXTURE.widget.series.map((s,i) => `<div><dt><i class="swatch c${i+1}" aria-hidden="true"></i>${s.label}</dt><dd>${i === 0 ? '21.0' : REVIEW_FIXTURE.widget.latest[i].value} °C</dd></div>`).join('')}</dl>${state === 'read' ? errorBlock('read','pinned') : state === 'refreshing' ? refreshLine() : ''}${widgetPlot()}<p class="chart-summary">Last point <time datetime="2026-09-23T09:10:00.000Z">11:10</time> · 12 min ago</p><p class="widget-foot">${icon('pin')} You pinned this from a conversation. It updates every minute without asking the AI.</p></section>`);
}
function server() {
  const header = `<a class="back" href="${href('overview')}" aria-label="Back to Overview">${icon(platform === 'android' ? 'arrow' : 'back')}${platform === 'android' ? '' : 'Overview'}</a><div class="server-page-head"><div class="tile">${icon('server')}</div><h1>pve-02</h1>${['loading','no-copy'].includes(state) ? '' : state === 'empty' ? '<span class="pill"><i class="dot ring" aria-hidden="true"></i>Learning</span>' : '<span class="pill warn"><i class="dot" aria-hidden="true"></i>Running warm</span>'}<div class="actions">${ask()}</div></div><nav class="tabs" aria-label="pve-02"><a href="${href('server')}" ${state === 'machines-empty' ? '' : 'aria-current="page"'}>Summary</a><a href="${href('server','&state=machines-empty')}" ${state === 'machines-empty' ? 'aria-current="page"' : ''}>Machines ${['loading','empty','no-copy'].includes(state) ? '' : `<small>${state === 'machines-empty' ? 0 : 14}</small>`}</a><a href="${href('server')}">Storage ${['loading','empty','no-copy'].includes(state) ? '' : '<small>4</small>'}</a><a href="${href('server')}">Sensors</a><a href="${href('server')}">Backups</a><a href="${href('server')}">System</a></nav>`;
  if (state === 'loading') return header + loading('server');
  if (state === 'empty') return header + empty('server');
  if (state === 'machines-empty') return header + empty('machines');
  const metric = ['Processor','Memory','Space','Temperature'].map((name,i) => `<div class="metric"><span class="eyebrow">${name}</span><strong>${['Quiet','Plenty free','Plenty free','Normal'][i]}</strong><span>${['18 % in use','23 GB free','Full in about 5 months','CPU package 71 °C'][i]}</span><svg class="spark" viewBox="0 0 200 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 21 10 20 20 21 30 20 40 21 50 20 60 21 70 20 80 21 90 20 100 21 110 20 120 21 130 20 140 21 145 3 150 21 160 20 170 21 180 20 200 21" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>`).join('');
  return header + (['action','completed','refused'].includes(state) ? errorBlock(state,'server') : state === 'read' || state === 'no-copy' ? errorBlock('read','server',state === 'no-copy') : state === 'refreshing' ? refreshLine() : '') + (state === 'no-copy' ? '' : `<section class="panel metric-strip" aria-label="Last saved readings">${metric}</section><div class="server-columns"><section class="panel"><div class="panel-head"><h2>Busiest machines</h2><span class="muted">12 of 14 running</span></div>${[['home-assistant','6.1 %','3.0 / 8 GB'],['nextcloud','4.8 %','6.2 / 8 GB'],['unifi','2.9 %','1.4 / 2 GB'],['frigate','2.2 %','3.1 / 4 GB'],['pihole','0.4 %','205 MB / 1 GB']].map(row => `<div class="machine-row">${row.map(x=>`<span>${x}</span>`).join('')}</div>`).join('')}</section><div class="stack"><section class="panel"><div class="panel-head"><h2>Worth a look</h2></div><p class="quiet-copy">Nothing needs a look.</p><details class="fold"><summary>Show 3 heads-ups</summary><p><b>CPU package at 79 °C</b><br>Up to 79 °C during the 03:00 backups.</p><p><b>Storage “local-lvm” full in about 5 months</b><br>At the rate it filled last week</p><p><b>4 updates available</b><br>1 security update</p></details></section><section class="panel"><div class="panel-head"><h2>Backups</h2></div><p class="quiet-copy"><b>14 of 14 machines backed up</b><br>Yesterday 20:22 · 41 min</p></section></div></div><details><summary>Technical details</summary><pre>Proxmox VE 9.2 · Ryzen AI MAX+ PRO</pre></details>`);
}
function automationRow(row) {
  const waiting = row.label === 'Waiting for you';
  const isFailure = row.lastStatus === 'failed';
  const green = row.label === 'On' && (!isFailure || keep);
  const bars = waiting || !row.bars.length ? '' : `<span class="bars" aria-hidden="true">${row.bars.map(tone => `<i class="${tone === 'quiet' ? 'short' : tone === 'bad' ? 'fail' : ''}" ${keep && tone === 'bad' ? 'style="background:var(--bad)"' : tone === 'warn' ? 'style="background:var(--warn)"' : ''}></i>`).join('')}</span>`;
  return `<a href="#automation" data-preview="This would open ${esc(row.name)}. Its existing page holds the switch and recent runs; open the failed run to see what happened before considering another run." class="automation-row ${['Off','Not on yet'].includes(row.label) ? 'quiet-row' : ''}" aria-label="${esc(row.accessibilityLabel)}"><span class="tile">${icon(row.source === 'schedule' ? 'clock' : row.source === 'message' ? 'chat' : 'overview')}</span><span><span class="auto-name">${esc(row.name)}</span><span class="auto-when">${esc(row.when)}</span><span class="state-line"><i class="dot ${green ? 'green' : !waiting ? 'ring' : ''}" aria-hidden="true"></i><span class="${waiting ? 'warn' : ''}">${row.label}</span><span aria-hidden="true">·</span>${bars}<span class="${isFailure && !keep ? 'past-failure' : ''}">${esc(row.line)}</span></span></span>${icon('chevron')}</a>`;
}
function composer() {
  return native ? `<button class="composer" data-preview="This would open the native New chat sheet to describe an automation."><span>Tell ${esc(assistant)} what to do on its own…</span><span class="send">${icon('send')}</span></button>` : `<div class="composer"><input id="automation-request" aria-label="Describe an automation" placeholder="Tell ${esc(assistant)} what should happen on its own…"><button class="plain" data-preview="The existing File control attaches a file to the new Chat request." aria-label="Attach a file">${icon('file')}File</button><button class="send" aria-label="Send automation request" data-preview="This would start a Chat thread proposing an automation; it does not turn one on immediately.">${icon('send')}</button></div><div class="ideas">${['Each morning, sum up my new mail','Every Monday, tell me how thetitan is doing','Each night at 23:00, tell me if a light is still on'].map(idea => button(idea,'This fills the Automations field with the selected idea.')).join('')}</div>`;
}
function automations() {
  const tag = !['loading','empty','no-copy'].includes(state) ? `<aside class="review-tag"><b>${keep ? 'Keeps AP-6330, AP-6380 and AP-1093' : 'Decision for John — reopens AP-6330, AP-6380, AP-1093'}</b><br>${keep ? 'Shipped green On and red past-run bar, preserved for comparison.' : 'Only the failed-run row changes: neutral On, amber past-run result. The automation stays enabled.'}<a href="${href('automations',`&state=normal&variant=${keep ? 'proposal' : 'keep'}`)}">${keep ? 'See variant' : 'See version that keeps the decisions'}</a></aside>` : '';
  const list = `<p class="eyebrow list-label">Automations · ${REVIEW_FIXTURE.automationRows.length}</p><section class="panel" aria-label="Automations">${REVIEW_FIXTURE.automationRows.map(automationRow).join('')}</section>`;
  return tag + heading('Automations', `What ${assistant} does on its own. To make one or change one, tell ${assistant}.`) + composer() + (state === 'loading' ? loading('automations') : state === 'empty' ? empty('automations') : `${state === 'read' || state === 'no-copy' ? errorBlock('read','automations',state === 'no-copy') : state === 'refreshing' ? refreshLine() : ''}${state === 'no-copy' ? '' : list}`);
}
const fragment = query.get('fragment') === '1';
document.body.classList.toggle('fragment', fragment);
const content = fragment ? (state === 'loading' ? loading(screen) : empty(screen)) : { overview, pinned, server, automations }[screen]();
document.getElementById('app').innerHTML = `${fragment ? '' : native ? `<div class="status-bar" aria-hidden="true"><span>11:22</span><span>${icon('signal')}</span></div>` : sidebar()}<main class="main" id="main">${content}</main>${native && !fragment ? tabBar() : ''}`;
document.title = `${screen === 'server' ? 'pve-02' : screen === 'automations' ? 'Automations' : 'Overview'} · ${state} · ${platform} · ${theme} · mockup`;
const dialog = document.getElementById('preview-dialog');
let opener;
document.addEventListener('click', event => {
  const target = event.target.closest('[data-preview]');
  if (!target) return;
  event.preventDefault();
  if (target.textContent.trim() === 'Describe an automation' && !native) { document.getElementById('automation-request').focus(); return; }
  opener = target;
  document.getElementById('dialog-copy').textContent = target.dataset.preview;
  dialog.showModal();
});
dialog.addEventListener('close', () => opener?.focus());
document.querySelectorAll('details.fold').forEach(details => details.addEventListener('toggle', () => {
  details.querySelector('summary').textContent = details.open ? 'Show fewer' : 'Show 3 heads-ups';
}));
