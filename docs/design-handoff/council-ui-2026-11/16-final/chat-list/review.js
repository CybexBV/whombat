const query=new URLSearchParams(location.search);
let theme=query.get('theme')==='dark'?'dark':'light';
const platform=document.getElementById('platform'),state=document.getElementById('state');
platform.value=query.get('platform')||'desktop';state.value=query.get('state')||'normal';
function draw() {
 const params=new URLSearchParams({platform:platform.value,theme,state:state.value});
 document.documentElement.dataset.theme=theme;
 document.querySelector('#theme-toggle').textContent=`Use ${theme==='light'?'dark':'light'} theme`;
 document.querySelector('#after').src=state.value==='normal'?`${platform.value}-${theme}.png`:`${platform.value}-${state.value}-${theme}.png`;
 document.querySelector('#before').hidden=state.value!=='normal';document.querySelector('#no-before').hidden=state.value==='normal';
 document.querySelector('#before').src=`before-${platform.value}-${theme}.png`;
 document.querySelector('#full-size').href=`mockup.html?${params}`;
 document.querySelector('#largest').href=`mockup.html?${params}&text=largest`;
 document.querySelector('#after-caption').textContent=`Final · ${platform.options[platform.selectedIndex].text} · ${theme} · ${state.options[state.selectedIndex].text}`;
 const old=new URLSearchParams({platform:platform.value==='phoneweb'?'phone-web':platform.value,theme,state:state.value==='failed'?'error':state.value==='saved-failed'?'saved-error':state.value});
 document.querySelector('#earlier').href=`../../11-chat/mockup.html?${old}`;
}
platform.addEventListener('change',draw);state.addEventListener('change',draw);document.querySelector('#theme-toggle').addEventListener('click',()=>{theme=theme==='light'?'dark':'light';draw();});draw();
