(() => {
 const screen=document.body.dataset.screen,q=new URLSearchParams(location.search);
 const platform=document.querySelector('#platform'),state=document.querySelector('#state'),surface=document.querySelector('#surface');
 let theme=q.get('theme')==='dark'?'dark':'light';platform.value=q.get('platform')||'desktop';state.value=q.get('state')||'normal';if(surface)surface.value=q.get('surface')||'details';
 function draw(){
  const native=['ios','android'].includes(platform.value),params=new URLSearchParams({platform:platform.value,theme,state:state.value,...(surface?{surface:native?'native':surface.value}:{})});
  document.documentElement.dataset.theme=theme;document.querySelector('#theme-toggle').textContent=`Use ${theme==='light'?'dark':'light'} theme`;
  if(surface)surface.disabled=native;
  const card=surface&&!native&&surface.value==='card',suffix=state.value==='normal'?(card?'-card':''):'-'+state.value;
  document.querySelector('#after').src=`${platform.value}${suffix}-${theme}.png`;
  document.querySelector('#before').src=`before-${platform.value}${card?'-card':''}-${theme}.png`;
  document.querySelector('#before').hidden=state.value!=='normal';document.querySelector('#no-before').hidden=state.value==='normal';
  document.querySelector('#full-size').href=`mockup.html?${params}`;
  document.querySelector('#largest').href=`mockup.html?${params}&text=largest${screen==='inbox'?'&focus=approval':''}`;
  const refresh=new URLSearchParams(params);refresh.set('state','saved-failed');document.querySelector('#refresh-failed').href=`mockup.html?${refresh}`;
  document.querySelector('#proof').src=`reading-proof-${theme}.png`;document.querySelector('#proof-link').href=`reading-proof-${theme}.png`;
  document.querySelector('#after-caption').textContent=`Final · ${platform.options[platform.selectedIndex].text} · ${state.options[state.selectedIndex].text} · ${theme}`;
  document.querySelectorAll('[data-kind]').forEach(a=>{const payload=new URLSearchParams(params);payload.set('kind',a.dataset.kind);payload.set('length','long');payload.set('state',a.hasAttribute('data-unknown')?'answer-unknown':'normal');a.href=`mockup.html?${payload}`;});
  document.querySelectorAll('[data-payload]').forEach(img=>img.src=`phoneweb-${img.dataset.payload}-${theme}.png`);
 }
 platform.addEventListener('change',draw);state.addEventListener('change',draw);surface?.addEventListener('change',draw);document.querySelector('#theme-toggle').addEventListener('click',()=>{theme=theme==='light'?'dark':'light';draw();});draw();
})();
