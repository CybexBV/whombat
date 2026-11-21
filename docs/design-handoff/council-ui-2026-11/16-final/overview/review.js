const screen=document.body.dataset.screen;
const q=new URLSearchParams(location.search),platform=document.getElementById('platform'),scene=document.getElementById('scene');
let theme=q.get('theme')==='dark'?'dark':'light';platform.value=q.get('platform')||'desktop';
const extra={overview:[['connections','Connections · real logos'],['pinned','Pinned · saved chart'],['pinned-widget','Pinned · chart at its reading time'],['pinned-widget-saved-failed','Pinned · refresh failed, old readings'],['connections-largest','Connections · largest text'],['pinned-largest','Pinned · largest text']],server:[['blackbox','blackbox · same failure'],['unknown','the-falcon · unknown time'],['facts','pve-02 · technical facts and heads-up'],['blackbox-saved','blackbox · failed refresh'],['pve-01','pve-01 · same report'],['thetitan','thetitan · same report'],['machines','Machines tab'],['backups','Backups tab'],['history','Reading history'],['history-largest','Reading history · largest text']],connection:[['controls','Controls'],['heads-ups','Expanded heads-ups']],automations:[['worked','Run #41 · worked'],['run-failed','Run #26 · failed'],['skipped','Run #38 · skipped'],['waiting','Run #48 · waiting'],['history','Recent run history'],['schedules','Only tells you schedules']]};
for(const [value,text] of extra[screen]||[]){const option=document.createElement('option');option.value=value;option.textContent=text;scene.append(option);}
scene.value=q.get('scene')||'normal';
function draw(){
 const p=platform.value,s=scene.value,w=p==='desktop'?1440:390,h=p==='desktop'?900:844;
 document.documentElement.dataset.theme=theme;document.getElementById('theme-toggle').textContent=`Use ${theme==='light'?'dark':'light'} theme`;
 const before=document.getElementById('before'),native=p==='ios'||p==='android';before.src=`../../${native?'08-native-capture':'01-groundwork'}/png/${p==='phoneweb'?'phone-web':p}-${screen}-${theme}.png`;before.hidden=s!=='normal';document.getElementById('before-note').hidden=s!=='normal';document.getElementById('no-before').hidden=s==='normal';
 document.getElementById('before-caption').textContent=`Before · ${native?'step 08 native fixture runtime':'step 01 built web fixture'} · ${theme}`;
 const image=document.getElementById('after'),crop=document.getElementById('crop');let group,row,params={};
 if(screen!=='automations'){
  if(['loading','empty','failed','saved-failed'].includes(s))params={state:s};
  else if(s==='lower')params={focus:'later',expand:'all'};
  else if(s==='largest')params={text:'largest'};
  else if(screen==='overview'&&s!=='normal')params={section:s.startsWith('connections')?'connections':'pinned',...(s.includes('widget')?{focus:'pinned'}:{}),...(s.includes('saved-failed')?{state:'saved-failed'}:{}),...(s.includes('largest')?{text:'largest'}:{})};
  else if(screen==='server')params=s==='blackbox'?{server:'blackbox'}:s==='unknown'?{server:'the-falcon'}:s==='facts'?{expand:'all'}:s==='blackbox-saved'?{server:'blackbox',state:'saved-failed'}:['pve-01','thetitan'].includes(s)?{server:s}:['machines','backups','history','history-largest'].includes(s)?{tab:s.split('-')[0],...(s.includes('largest')?{text:'largest'}:{})}:{};
  else if(screen==='connection')params=s==='controls'?{focus:'controls'}:s==='heads-ups'?{focus:'later',expand:'all'}:{};
  image.src=`${p}-${theme}${s==='normal'?'':'-'+s}.png`;image.style='';crop.style=`max-width:${w}px;margin:auto`;crop.className='';
 }else if(s==='normal'){image.src=`${p}-${theme}.png`;image.style='';crop.style=`max-width:${w}px;margin:auto`;crop.className='';}
 else{
  const common=['loading','empty','failed','saved-failed','lower'];
  if(common.includes(s)){group=`png/states-${theme}.png`;row=common.indexOf(s);params=s==='lower'?{focus:'later',expand:'all'}:{state:s};}
  else if(s==='largest'){group=`../overview/png/largest-${theme}.png`;row=['overview','server','connection','automations'].indexOf(screen);params={text:'largest'};}
  else if(screen==='server'){group=`png/story-${theme}.png`;row=['blackbox','unknown','facts','blackbox-saved'].indexOf(s);params=[{server:'blackbox'},{server:'the-falcon'},{server:'pve-02',expand:'all'},{server:'blackbox',state:'saved-failed'}][row];}
  else if(screen==='connection'){group=`png/expanded-${theme}.png`;row=s==='controls'?0:1;params=row?{expand:'all',focus:'later'}:{focus:'controls'};}
  else{group=`png/runs-${theme}.png`;row=['worked','run-failed','skipped','waiting','history','schedules'].indexOf(s);params=[{view:'run',run:'arn_41'},{view:'run',run:'arn_26'},{view:'run',automation:'aut_suspected-bug',run:'arn_38'},{view:'run',automation:'aut_fix-web',run:'arn_48'},{view:'detail'},{focus:'later'}][row];}
  const x=[16,1472,1878,2284][['desktop','phoneweb','ios','android'].indexOf(p)],y=48+row*948;
  image.src=group;crop.className='atlas';crop.style=`aspect-ratio:${w}/${h};max-width:${w}px;margin:auto`;image.style=`width:${2690/w*100}%;left:${-x/w*100}%;top:${-y/h*100}%;`;
 }
 document.getElementById('after-caption').textContent=`Final · ${platform.options[platform.selectedIndex].text} · ${theme} · ${scene.options[scene.selectedIndex].text}`;
 const paramsOut=new URLSearchParams({platform:p,theme,...params});document.getElementById('full-size').href=`mockup.html?${paramsOut}`;paramsOut.set('text','largest');document.getElementById('largest').href=`mockup.html?${paramsOut}`;
}
platform.addEventListener('change',draw);scene.addEventListener('change',draw);document.getElementById('theme-toggle').addEventListener('click',()=>{theme=theme==='light'?'dark':'light';draw();});draw();
