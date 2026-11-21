const controls=['screen','platform','state','theme'].map(id=>document.getElementById(id));
const query=new URLSearchParams(location.search);
for(const el of controls) if([...el.options].some(o=>o.value===query.get(el.id))) el.value=query.get(el.id);
function update() {
 const [screen,platform,state,theme]=controls.map(c=>c.value);
 const native=platform==='ios'||platform==='android',desktop=platform==='desktop';
 const shown=state==='action'&&screen!=='server'?'read':state==='unknown'&&screen==='automations'?'normal':state;
 const url='mockup.html?'+new URLSearchParams({screen,platform:native?platform:'web',state:shown,theme});
 document.documentElement.dataset.theme=theme;
 history.replaceState(null,'','?'+new URLSearchParams({screen,platform,state,theme}));
 const before=native?`../08-native-capture/png/${platform}-${screen}-${theme}.png`:`png/before-${desktop?'desktop':'phone-web'}-${screen}${shown==='read'&&!desktop?'-read':''}-${theme}.png`;
 const gap=!['normal','unknown','read'].includes(shown)||(native||desktop)&&shown==='read';
 document.getElementById('gap').hidden=!gap;
 document.getElementById('gap').textContent='GAP: no same-state before capture. The normal fixture screen below is context only.';
 const img=document.getElementById('before-image');img.src=before;img.alt=`${screen}, ${platform} fixture app, ${gap?'normal context':shown}, ${theme}`;img.className=desktop?'desktop-evidence':'phone-evidence';
 document.getElementById('before-link').href=before;
 document.getElementById('before-note').textContent=native?'Genuine native capture from step 08, 14:05 fixture clock. New report-time scenarios are drawn on the right.':shown==='read'&&!desktop?'The query failed with data retained. Overview hides this error; the server and list retain their shipped treatment.':'Latest-main fixture capture, 11:22. The supplied report times are present but hidden for online servers.';
 document.getElementById('after-note').textContent=`${native?'Native HTML drawing · 14:05 fixture clock':desktop?'1440 × 900 web drawing':'390 × 844 web drawing · drawer closed'} · ${shown}. ${native?'No native runtime or screen-reader certification is claimed.':''}`;
 document.getElementById('scenario').textContent=`${screen==='server'?'pve-02':screen==='automations'?'Automations':'Overview'} · ${platform} · ${shown} · ${theme}${shown!==state?' · state adjusted for this screen':''}`;
 const frame=document.getElementById('after-frame');frame.src=url;frame.width=desktop?1440:390;frame.height=desktop?900:844;
 frame.style.transform=desktop?'scale(.45)':'';frame.style.transformOrigin='top left';frame.parentElement.style.height=desktop?'405px':'844px';
 document.getElementById('open').href=url;
 document.getElementById('large').href=url+'&text=large';
 document.getElementById('png').href=desktop&&screen!=='automations'?`png/after-desktop-${screen}-${theme}.png`:`png/after-${native?platform:'phone-web'}-states-${theme}.png`;
}
controls.forEach(c=>c.addEventListener('change',update));update();
