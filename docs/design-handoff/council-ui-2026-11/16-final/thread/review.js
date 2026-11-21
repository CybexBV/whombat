(() => {
 const $=id=>document.getElementById(id),q=new URLSearchParams(location.search);
 let theme=q.get('theme')==='dark'?'dark':'light';
 for(const id of ['platform','scene','state'])if(q.has(id))$(id).value=q.get(id);
 $('largest').checked=q.get('text')==='largest';
 const resize=new ResizeObserver(entries=>entries.forEach(({target})=>{const inner=target.firstElementChild;inner.style.transform=`scale(${target.clientWidth/Number(target.dataset.width)})`;}));
 function crop(r){const c=r.crop;return `<div class="frame" data-width="${c.width}" style="width:${c.width}px;aspect-ratio:${c.width}/${c.height}"><div class="crop" style="width:${c.width}px;height:${c.height}px"><img src="${r.file}" alt="${r.before?'Earlier':'Final'} ${r.scene}, ${r.platform}, ${r.theme}, ${r.text} text" style="left:-${c.x}px;top:-${c.y}px"></div></div>`;}
 function draw(){
  const platform=$('platform').value,state=$('state').value;
  if(state!=='normal')$('scene').value='normal';$('scene').disabled=state!=='normal';
  $('largest').disabled=platform==='desktop';if(platform==='desktop')$('largest').checked=false;
  const scene=$('scene').value,text=$('largest').checked?'largest':'normal';
  document.documentElement.dataset.theme=theme;$('theme-toggle').textContent=`Use ${theme==='light'?'dark':'light'} theme`;
  const after=THREAD_CAPTURES.find(r=>!r.before&&r.platform===platform&&r.theme===theme&&r.scene===scene&&r.state===state&&r.text===text);
  $('after').innerHTML=after?crop(after):'<p class="gap">This PNG combination is unavailable. Open the interactive drawing.</p>';
  $('after-caption').textContent=`${platform==='desktop'?'1440×900 desktop':`390×844 ${platform==='phoneweb'?'phone web':platform}`} · ${theme} · ${text==='largest'?(platform==='phoneweb'?'200% text':'kept 1.6× text cap'):'normal text'} · ${state==='normal'?scene:state}. HTML design, not a rebuilt app.`;
  if(state!=='normal'){
   $('before').innerHTML='<p class="gap">GAP: no matching earlier thread read-state capture. The final scene is a local query-state alternative, not a new incident in the shared story.</p>';
   $('before-caption').textContent='No unrelated successful or blank page is passed off as this read state.';
  }else if(scene==='normal'){
   let file,kind;
   if(platform==='desktop'){file=`../../01-groundwork/png/desktop-thread-${theme}.png`;kind='Groundwork fixture web capture, 1440×900; its earlier clock is retained.';}
   else if(platform==='phoneweb'){file=`../../08-native-capture/png/phone-web-1405-thread-${theme}.png`;kind='Step 08 matching-moment fixture web capture, 390×844.';}
   else{file=`../../08-native-capture/png/${platform}-thread-${theme}${text==='largest'?'-largest':''}.png`;kind=`Step 08 actual native ${text==='largest'?'largest-system-text ':''}capture, 390×844. Different from the HTML after drawing.`;}
   if(text==='largest'&&platform==='phoneweb'){$('before').innerHTML='<p class="gap">GAP: no matching 200% phone-web thread before PNG.</p>';}else $('before').innerHTML=`<img class="direct" src="${file}" alt="Earlier captured ${platform} pve-02 thread, ${theme}">`;
   $('before-caption').textContent=kind;
  }else if(scene.startsWith('plan')){
   $('before').innerHTML='<p class="gap">This everyday card was missing from the final thread views. No earlier final-screen picture is invented.</p>';
   $('before-caption').textContent='Added in round four; source facts are listed in NOTES.md.';
  }else{
   const before=THREAD_CAPTURES.find(r=>r.before&&r.platform===platform&&r.theme===theme&&r.scene===scene);
   $('before').innerHTML=before?crop(before):'<p class="gap">GAP: no matching earlier card picture.</p>';
   $('before-caption').textContent=`${platform==='desktop'?'Step 04':'Step 15'} HTML card design, captured at the same viewport before this drawing. ${text==='largest'?'Normal-text context only; matching kept-largest before is a GAP.':''}`;
  }
  const decisions=scene.startsWith('council')?['AP-7626','AP-7718']:scene.startsWith('delegation')?['AP-7704','AP-7730','AP-7731']:[];
  $('authority').innerHTML=decisions.map(id=>`<p>Reopens ${id} — decided by Dusty for John's review</p>`).join('');
  $('context').textContent=scene.startsWith('plan')?'Supplemental invoice-plan fixture: current and waiting-step alternatives, with their actual 11:22 update time. Phone cards start folded and open in place. No step is started by the drawing.':scene==='normal'?'Binding final story: 23 September 2026, 14:05 Europe/Amsterdam. Approval 33 is still pending; historical 91% / 38 GB wording is not rewritten as a current hardware reading. All four platforms use the same message payload.':'Supplemental card example from the existing step 04 fixture, inside the final shell. It does not append a council or delegation message to the shared pve-02 thread or change the shared Inbox/Feedback counts.';
  const params=new URLSearchParams({platform,theme,scene,state,text});$('full-size').href='mockup.html?'+params;history.replaceState(null,'','?'+params);
  resize.disconnect();document.querySelectorAll('.frame').forEach(el=>resize.observe(el));
 }
 for(const id of ['platform','scene','state','largest'])$(id).addEventListener('change',draw);
 $('theme-toggle').addEventListener('click',()=>{theme=theme==='light'?'dark':'light';draw();});draw();
})();
