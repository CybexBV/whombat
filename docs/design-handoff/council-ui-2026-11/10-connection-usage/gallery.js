const elements=Object.fromEntries(['screen','platform','theme','state','comparisons'].map(id=>[id,document.getElementById(id)]));
const choices={connection:[['normal','Arrival'],['partial','Partly read'],['stale','Older readings · failed refresh'],['refreshing','Refreshing'],['no-copy','Read failed · no saved copy']],usage:[['normal','Arrival'],['read','Read failed · saved totals'],['no-copy','Read failed · no saved copy'],['refreshing','Refreshing'],['provider','Marked variant · needs new data']],settings:[['normal','Selected Settings'],['advanced','Find Usage in Advanced']]};
function updateStates(){elements.state.innerHTML=choices[elements.screen.value].map(([value,label])=>`<option value="${value}">${label}</option>`).join('');}
function draw(){
  const screen=elements.screen.value,platform=elements.platform.value,theme=elements.theme.value,state=elements.state.value;
  document.documentElement.dataset.theme=theme;
  const phone=platform!=='web',native=['android','ios'].includes(platform);
  const name=screen==='connection'?'Home Assistant':screen==='usage'?'Usage':'Settings';
  const params=new URLSearchParams({screen,platform,theme,state});
  const href=variant=>'mockup.html?'+params+'&variant='+variant;
  const decision=screen==='connection'?'Decision for John — reopens UIR-70':screen==='usage'||state==='advanced'?'Decision for John — reopens STG-03, STG-10, STG-12':'Contrast proposal · no decision reopened';
  const before=`png/before-${phone?'phone-web':'web'}-${screen}-${theme}.png`;
  const img=(src,alt)=>`<div class="frame${phone?' phone':''}"><a href="${src}"><img src="${src}" alt="${alt}"></a></div>`;
  const live=variant=>`<div class="frame${phone?' phone':''} live-wrap"><iframe class="live${phone?' phone':''}" src="${href(variant)}" title="${name}, ${platform}, ${theme}, ${state}, ${variant} proposal"></iframe></div>`;
  const after=state==='normal'?img(`png/after-${platform}-${screen}-${theme}.png`,`${name}, ${platform} HTML drawing, ${theme}`):live('folded');
  const gap=native||state!=='normal';
  elements.comparisons.innerHTML=`<div class="compare"><figure><figcaption><b>Before · ${gap?'GAP for this platform/state':'fixture capture'}</b>${gap?'A native screen or this failure state was not captured. No reconstructed before is substituted.':'Unchanged app, same fixture world, viewport and theme.'}</figcaption>${gap?`<div class="frame gap"><h2>${native?'Native '+platform+' before: GAP':'Same-state before: GAP'}</h2><p>${native?'The preview runtime packages assets; there is no verified fixture-only native build in this checkout.':'The failure is an explicitly seeded proposal scenario, not the arrival picture.'}</p><a href="${before}">Open normal ${phone?'phone-width web context':'fixture before'}</a></div>`:img(before,`${name}, fixture web before, ${theme}`)}</figure><figure><figcaption><b>${decision}</b>${screen==='connection'?'Heads-ups folded; same health and research.':screen==='usage'?'Usage names one existing destination; totals keep their scope.':platform==='phone-web'?'The closed web sidebar is unchanged; Advanced shows the same destination name.':'Selected words use opaque ink2 on the same surface.'} <a href="${href('folded')}">Open actual-size drawing</a></figcaption>${after}</figure></div>
  ${screen!=='settings'||state==='advanced'?`<h2>Decision comparison · same state</h2><div class="compare"><figure><figcaption><b>Keeps ${screen==='connection'?'UIR-70':'STG-03, STG-10, STG-12'}</b>${screen==='connection'?'Two SOON rows remain visible; four more unfold.':'The shared destination name stays Spend.'} <a href="${href('keep')}">Open keeps-decision version</a></figcaption>${live('keep')}</figure><figure><figcaption><b>${decision}</b>${screen==='connection'?'All six routine heads-ups fold in one place (QN-27).':'The existing Advanced row and page both say Usage.'} <a href="${href('folded')}">Open decision variant</a></figcaption>${live('folded')}</figure></div>`:''}`;
  requestAnimationFrame(sizeFrames);
}
function sizeFrames(){for(const iframe of document.querySelectorAll('iframe.live')){const width=iframe.classList.contains('phone')?390:1440;const scale=iframe.parentElement.clientWidth/width;iframe.style.transform=`scale(${scale})`;iframe.parentElement.style.height=`${(width===390?844:900)*scale}px`;}}
elements.screen.addEventListener('change',()=>{updateStates();draw();});
for(const id of ['platform','theme','state'])elements[id].addEventListener('change',draw);
window.addEventListener('resize',sizeFrames);
updateStates();draw();
