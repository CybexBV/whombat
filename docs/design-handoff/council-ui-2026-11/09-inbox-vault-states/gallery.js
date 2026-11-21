const states = {
  inbox:[['normal','Shipped layout'],['empty','Empty'],['loading','First load'],['error','Read failed · Try again'],['handling','Long assistant group'],['headsups','Heads-ups opened'],['settle','Settle · Undo and focus']],
  vault:[['normal','Closed by default · keeps VT-04'],['closed','After close · focus return'],['locked','Locked · new-data variant'],['empty','Empty'],['loading','First load'],['open','Entry opened · sealed value'],['entry-loading','Entry loading'],['entry-error','Entry read failed · close or retry'],['reveal-error','Failed reveal · reopens VT-04'],['copied','Public-key copy feedback']],
};
const get=id=>document.getElementById(id);
const params = new URLSearchParams(location.search);
for(const id of ['screen','platform','theme','text']) if(params.has(id))get(id).value=params.get(id);
function stateOptions(){get('state').replaceChildren(...states[get('screen').value].map(([value,label])=>new Option(label,value)));}
stateOptions();
if(params.has('state')&&states[get('screen').value].some(([s])=>s===params.get('state')))get('state').value=params.get('state');
function update(){
  const values=Object.fromEntries(['screen','state','platform','theme','text'].map(id=>[id,get(id).value]));
  document.documentElement.dataset.theme=values.theme;
  const url='mockup.html?'+new URLSearchParams(values);
  get('after').src=url;get('open').href=url;
  const width=values.platform==='web'?1440:390,height=values.platform==='web'?900:844;
  for(const id of ['after','keep']){get(id).width=width;get(id).height=height;}
  get('after-note').textContent=values.platform==='web'?'1440 × 900. The frame scrolls horizontally so the drawing keeps its intended size.':'390 × 844 HTML drawing. Native pixels and assistive technology remain unverified.';
  const match=values.screen==='inbox'?(values.state==='normal'?'normal':values.state==='error'?'error':null):(values.state==='normal'?'normal':values.state==='open'?'open':null);
  const native=values.platform!=='web';
  const file=`png/before-${values.screen}-${match||'normal'}-${values.theme}.png`;
  get('before').hidden=native;get('before-link').hidden=native;get('gap').hidden=!native;
  get('before').src=file;get('before-link').href=file;
  get('before').alt=`Before ${values.screen}, desktop web, ${match||'normal'}, ${values.theme}`;
  get('before-note').textContent=native?'Native before: GAP in both themes.':match?'Same state, same fixture world.':'Context only: the shipped default state. This state has no before screenshot; see the GAP register.';
  get('gap').textContent='GAP · No verified fixture-only native binary in this checkout. The preview runtime supplies sandbox asset bytes, not a native screen renderer. Existing emulator/simulator sessions were left alone.';
  const variant=values.state==='locked'||values.state==='reveal-error'||values.state==='copied'&&native;
  get('decision').hidden=!variant;
  if(variant){
    const keepState=values.state==='reveal-error'?'entry-error':values.state==='copied'?'open':'normal';
    get('keep').src='mockup.html?'+new URLSearchParams({...values,state:keepState});
    get('keep-note').textContent=values.state==='reveal-error'?'An entry read can fail. The saved secret remains write-only; Try again reads its metadata.':values.state==='locked'?'Entries start closed; saved values stay sealed. No separate Vault unlock step.':'The native entry has no shipped Copy control. Its metadata and sealed value stay as shipped.';
    get('variant-title').textContent=values.state==='reveal-error'?'Decision for John — reopens VT-04':values.state==='locked'?'Decision for John — separate Vault lock':'Variant — public-key copy on native';
    get('variant-note').textContent=values.state==='copied'?'No new data: the optional fixture’s public key is already present. The native Copy control is a proposed interaction.':'Needs new data. The required fields and the decision boundary are written in NOTES.md.';
  }
  history.replaceState(null,'','?'+new URLSearchParams(values));
}
for(const id of ['screen','state','platform','theme','text'])get(id).addEventListener('change',()=>{if(id==='screen')stateOptions();update();});
update();
