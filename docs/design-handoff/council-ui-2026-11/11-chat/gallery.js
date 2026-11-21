const ids=['platform','screen','state','theme','text'];
const q=new URLSearchParams(location.search);
for(const id of ids)if(q.has(id))document.getElementById(id).value=q.get(id);
function update(){
  const values=Object.fromEntries(ids.map(id=>[id,document.getElementById(id).value]));
  const {platform,screen,state,theme,text}=values;
  document.documentElement.dataset.theme=theme;
  const native=platform==='ios'||platform==='android';
  const width=platform==='desktop'?1440:390,height=platform==='desktop'?900:844;
  const before=document.getElementById('before');
  before.replaceChildren();
  if(state==='normal'&&text==='normal'){
    const image=document.createElement('img');
    image.src=native?`../08-native-capture/png/${platform}-${screen==='chat'?'chat-list':'thread'}-${theme}.png`:`../01-groundwork/png/${platform}-${screen==='chat'?'chat-list':'thread'}-${theme}.png`;
    image.width=width;image.height=height;image.alt=`${screen==='chat'?'Chat':'Thread'} · ${platform} · ${theme} · shipped fixture app`;before.append(image);
  }else{
    const gap=document.createElement('div');gap.className=`state-gap ${width===1440?'wide':''}`;
    gap.textContent=text==='largest'?'No matching before image at this exact size and state. Step 08 has the actual native largest-text captures; this drawing keeps its effective 1.6× cap.':'No matching before capture for this read state. A normal timeline would not prove what happens on an empty, loading or failed read.';before.append(gap);
  }
  const url=`mockup.html?${new URLSearchParams(values)}`;
  const frame=document.getElementById('after');frame.src=url;frame.style.width=width+'px';frame.style.height=height+'px';
  document.getElementById('full').href=url;
  document.getElementById('before-note').textContent=native?'Actual native fixture screenshot · step 08 · 23 September, 14:05.':'Actual web fixture screenshot · groundwork · 23 September, 11:22. Recaptured before authoring this step.';
  document.getElementById('after-note').textContent=native?'HTML design, not a native screenshot. Chat focuses on the memory and firmware questions; earlier history remains above.':'HTML drawing · same fixture words, chronological message order and thread card.';
  document.getElementById('context').textContent=`${width} × ${height} · ${native?'Native keeps long-press and its accessible More action. No extra message button adds height.':platform==='phone-web'?'Drawer closed. One 44px message actions button on the author line.':'The timeline stays; no replacement thread list.'} ${text==='largest'?(native?'Native body at its kept 1.6× cap; HTML proxy.':'Web text at 200%; no raised native cap.'):'Both themes use the real token stylesheet.'}`;
  document.getElementById('pictures').innerHTML=['desktop-chat','desktop-thread','phone-web-pair','ios-pair','android-pair','phone-web-actions','states','stages'].map(name=>`<figure><a href="png/${name}-${theme}.png"><img src="png/${name}-${theme}.png" alt="${name.replaceAll('-',' ')} · ${theme}"></a><figcaption>${name.replaceAll('-',' ')} · ${theme}</figcaption></figure>`).join('');
  history.replaceState(null,'',`?${new URLSearchParams(values)}`);
}
for(const id of ids)document.getElementById(id).addEventListener('change',update);
update();
