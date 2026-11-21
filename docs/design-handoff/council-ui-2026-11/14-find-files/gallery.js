const controls=['screen','platform','theme','state','text'];
const P=new URLSearchParams(location.search);for(const id of controls)if(P.has(id))document.getElementById(id).value=P.get(id);
function update(){const v=Object.fromEntries(controls.map(id=>[id,document.getElementById(id).value]));document.documentElement.dataset.theme=v.theme;const native=['ios','android'].includes(v.platform);let screen=v.screen,extra={};if(screen==='local'){screen='search';extra.q='home';}if(screen==='settings-search'){screen='search';extra.q='vault';}if(screen==='unloaded'){screen='search';extra.q='home';extra.state='unloaded';}
 const width=v.platform==='web'?1440:390,height=v.platform==='web'?900:844;const source=(v.platform==='phone'&&['inbox','vault'].includes(screen)?'phone-states.html?':'mockup.html?')+new URLSearchParams({...v,screen,...extra});document.querySelector('iframe').src=source;document.querySelector('#after-link').href=source;const box=document.querySelector('#after');box.dataset.width=width;box.dataset.height=height;
 let base=screen,context=false;if(['brief-request','source','automation','run','settings'].includes(base)){base=base==='automation'||base==='run'?'automations':'chat';context=true;}
 let before=native?`../08-native-capture/png/${v.platform}-${base==='chat'?'chat-list':base==='usage'?'usage':base}-${v.theme}.png`:`png/before-${v.platform}-${base}-${v.theme}.png`;
 if(native&&screen==='search'){before=`../08-native-capture/png/${v.platform}-chat-list-${v.theme}.png`;context=true;}
 if(v.platform==='web'&&['files','vault','inbox'].includes(base))before=`../01-groundwork/png/desktop-${base}-${v.theme}.png`;
 if(native&&screen==='files'&&v.platform==='android')before=`png/before-android-files-${v.theme}.png`;
 document.querySelector('#before').innerHTML=`<img src="${before}" alt="${base} in today’s ${v.platform} fixture app, ${v.theme}">`;document.querySelector('#before').style.maxWidth=width+'px';document.querySelector('#before-link').href=before;
 document.querySelector('#before-note').textContent=native&&screen==='files'?(v.platform==='android'?'Local Files gate enabled for capture only; fixture read fails.':'Step 08 scaffold. GAP: no new iOS Files-content capture.'):(context?'Arrival context. No matching shipped Search screen or new destination is implied.':'Current fixture pixels.');
 document.querySelector('#after-note').textContent=`${width} × ${height} · interactive HTML · ${v.text==='largest'?'200% content text':'standard text'}`;
 let note='Search and Usage are approved for the main design in this round. No decision documents are changed.';
 if(native&&screen==='search')note='Main design — John approved reopening AP-2645. Today’s phone app opens search links on the web; its Chat is beside the new Search screen.';
 if(screen==='files'&&v.state!=='ready')note='Seeded read state: '+v.state+'. Today’s arrival picture is context; it is not a matched before capture of this state.';
 if(screen==='brief-request')note='Evening-brief task remains partly unverified: this fixture has no evening card. The route prepares the shipped assistant settings request; it does not fabricate a schedule or answer.';
 document.querySelector('#note').textContent=note;
 history.replaceState(null,'','?'+new URLSearchParams(v));resize();}
function resize(){const b=document.querySelector('#after'),w=+b.dataset.width,h=+b.dataset.height;if(!w)return;const scale=Math.min(1,b.parentElement.clientWidth/w);b.style.width=w*scale+'px';b.style.height=h*scale+'px';const frame=b.querySelector('iframe');frame.style.width=w+'px';frame.style.height=h+'px';frame.style.transform=`scale(${scale})`;}
for(const id of controls)document.getElementById(id).addEventListener('change',update);window.addEventListener('resize',resize);update();
