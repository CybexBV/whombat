(() => {
 const $=id=>document.getElementById(id);
 const native=[['chat-list','Chat · badge'],['inbox','Inbox · badge'],['overview','Overview · badge and targets'],['automations','Automations · badge and targets'],['settings','Settings · badge and targets'],['connection','Home Assistant · controls and host link'],['connection-heads','Home Assistant · heads-ups folded'],['connection-open','Home Assistant · heads-ups open']];
 $('view').innerHTML='<optgroup label="Native screens">'+native.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')+'</optgroup><optgroup label="Cards at 390px">'+Cards.defs.concat([['council-round','Council · earlier agreement in words']]).map(([v,t])=>`<option value="card:${v}">${Cards.esc(t)}</option>`).join('')+'</optgroup>';
 const q=new URLSearchParams(location.search);
 for(const key of ['view','platform','theme'])if(q.has(key))$(key).value=q.get(key);
 $('expanded').checked=q.get('expanded')==='1';$('large').checked=q.get('large')==='1';
 function crop(r,prefix='') {return `<div class="crop" style="width:${r.crop.width}px;height:${r.crop.height}px"><img src="${prefix+r.atlas}" alt="${Cards.esc(r.id||r.screen)}, ${Cards.esc(r.platform)}, ${r.theme}${r.large?', 200% text':''}${r.expanded?', Details open':''}" style="left:-${r.crop.x||0}px;top:-${r.crop.y}px"></div>`;}
 function draw(){
  let v=$('view').value,p=$('platform').value,t=$('theme').value;
  if(p==='phone-web'&&!v.startsWith('card:')){$('view').value=v='card:council-done';}
  const card=v.startsWith('card:'),id=card?v.slice(5):null,large=$('large').checked,expanded=$('expanded').checked;
  document.documentElement.dataset.theme=t;
  const d=card?(id.startsWith('council')?['AP-7626','AP-7718']:id.startsWith('delegation')?['AP-7704','AP-7730','AP-7731']:[]):v.startsWith('connection')?[]:['AP-6412'];
  $('decisions').innerHTML=d.map(d=>`<p>Reopens ${d} — decided by Dusty for John’s review</p>`).join('');
  const beforeScreen=card?'thread':v.startsWith('connection')?'connection':v;
  if(card&&p==='phone-web'){
   const r=CARD_EVIDENCE.find(r=>r.platform==='phone-web'&&r.theme===t&&r.id===(id==='council-round'?'council-done':id));
   $('before-caption').textContent=id==='council-round'?'Step 04’s final council card, for layout context. Exact earlier-round capture GAP.':'Shipped phone-width web card from step 04, captured with fixtures. Retained at its original pixel width.';
   $('before').innerHTML=r?crop(r,'../04-cards/'):'<p class="gap">GAP: no matching shipped card capture.</p>';
  }else{
   $('before-caption').textContent=card?'Step 08 native thread for context only. Exact native card-family before is a GAP: step 08 did not capture this family.':v.startsWith('connection-')?'Step 08 Home Assistant initial view. A native lower-page heads-ups before capture is a GAP.':'Step 08’s native app capture at 390×844, retained unchanged.';
   $('before').innerHTML=`<img class="baseline" src="../08-native-capture/png/${p}-${beforeScreen}-${t}.png" alt="Captured ${p} ${beforeScreen}, ${t}">`;
  }
  const r=NATIVE_CARD_CAPTURES.find(r=>r.platform===p&&r.theme===t&&r.screen===(card?'card':v)&&(card?r.id===id:true)&&!!r.large===large&&(card?!!r.expanded===(large?false:expanded):true));
  $('after-caption').textContent=`${p==='phone-web'?'Phone-width web · drawer closed':p==='ios'?'iOS':'Android'} · 390px · ${t} · ${large?'200% text reflow':card&&expanded?'Details open':'starting state'}. Chromium rendering of the main design.`;
  $('after').innerHTML=r?crop(r):'<p class="gap">This combination has no PNG. 200% views cover the council final, editable delegation, Home Assistant and Overview. Use the HTML link for other combinations.</p>';
  $('context').textContent=card?'Step 04’s shared card anatomy, with Dusty’s main-design changes. The complete card continues below the phone viewport; scroll in the interactive mockup. Native renderings use the same fixture card export, not a claim that a native card was captured.':'Native implementation remains as captured in step 08. These drawings specify the badge, contrast, target-size and folding changes for implementation.';
  const u=new URLSearchParams({platform:p,theme:t,screen:card?'card':v.startsWith('connection')?'connection':v,expanded:expanded?'1':'0',large:large?'1':'0'});if(card)u.set('card',id);if(v.startsWith('connection-'))u.set('heads','1');
  $('open').href='mockup.html?'+u;
  history.replaceState(null,'','?'+new URLSearchParams({view:v,platform:p,theme:t,expanded:expanded?'1':'0',large:large?'1':'0'}));
 }
 document.querySelectorAll('select,input').forEach(e=>e.addEventListener('change',draw));draw();
})();
