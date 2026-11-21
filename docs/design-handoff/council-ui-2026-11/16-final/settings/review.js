(() => {
 const screen=document.body.dataset.screen,P=new URLSearchParams(location.search);
 let theme=P.get('theme')==='dark'?'dark':'light';
 const platform=document.querySelector('#platform'),scene=document.querySelector('#scene');
 if(['desktop','phoneweb','ios','android'].includes(P.get('platform')))platform.value=P.get('platform');
 function show(){
  const p=platform.value,s=scene.value;
  document.documentElement.dataset.theme=theme;document.querySelector('#theme-toggle').textContent=`Use ${theme==='light'?'dark':'light'} theme`;
  const before=document.querySelector('#before');before.src=`png/before-${p}-${theme}.png`;before.hidden=s!=='normal';document.querySelector('#before-gap').hidden=s==='normal';
  document.querySelector('#before-caption').textContent=`Before · ${screen==='settings'?'step 06':screen==='vault'?'step 09':'step 14'} static proposal · ${p} · ${theme}`;
  let file=`${p}-${theme}.png`,extra={};
  if(s==='states'){file=`png/${p}-states-${theme}.png`;extra.state='failed';}
  if(s==='largest'){file=p==='desktop'?`png/desktop-largest-${theme}.png`:`png/largest-text-${theme}.png`;extra.text='largest';}
  if(s==='brief-task'){file=p==='desktop'?`png/desktop-brief-time-${theme}.png`:`png/${p}-brief-task-${theme}.png`;extra={view:'brief',dialog:'time'};}
  if(s==='add-largest'){file=`png/add-largest-${theme}.png`;extra={text:'largest',dialog:'add'};}
  if(s==='windows'){file=p==='desktop'?`png/desktop-windows-${theme}.png`:`png/phone-windows-${theme}.png`;extra.window='week';}
  if(s==='provider-coverage'){file=`png/provider-coverage-${theme}.png`;extra.more='open';}
  document.querySelector('#after').src=file;document.querySelector('#after-caption').textContent=`Final · ${s} · ${theme}${['largest','add-largest','provider-coverage'].includes(s)&&p!=='desktop'?' · phone web / iOS / Android':` · ${p}`}`;
  document.querySelector('#drawing').href='mockup.html?'+new URLSearchParams({platform:p,theme,...extra});
 }
 platform.addEventListener('change',show);scene.addEventListener('change',show);document.querySelector('#theme-toggle').addEventListener('click',()=>{theme=theme==='light'?'dark':'light';show();});show();
})();
