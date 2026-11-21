const query = new URLSearchParams(location.search);
let theme = query.get('theme') || 'light';
const assistant = window.FINDABILITY_FIXTURE.assistant;
document.querySelectorAll('[data-assistant]').forEach(n=>{n.textContent=assistant;});
function pair(id,caption,variant='main'){
  const afterName=variant==='main'?'Proposed · main version':`Decision for John — reopens ${id==='search'?'AP-2274':'CN-11 / AP-2564'}`;
  const q=new URLSearchParams({platform:'web',screen:id,variant,theme});
  return `<div class="pair"><figure class="picture"><figcaption>Today · ${caption}</figcaption><a href="png/before-web-${id}-${theme}.png"><img src="png/before-web-${id}-${theme}.png" alt="Today’s ${caption}, ${theme}, 1440 by 900"></a></figure><figure class="picture"><figcaption>${afterName} · ${caption}</figcaption><a href="mockup.html?${q}"><img src="png/after-web-${id}-${theme}.png" alt="Proposed ${caption}, ${theme}, 1440 by 900"></a><a class="open" href="mockup.html?${q}">Open the full-size prototype →</a></figure></div>`;
}
function render(){
  document.documentElement.dataset.theme=theme;
  document.querySelector('#theme').textContent=theme==='light'?'Use dark theme':'Use light theme';
  document.querySelector('#main-pairs').innerHTML=[['chat','Chat’s header and navigation'],['files','Files'],['vault','Vault'],['settings','Settings front page']].map(([id,label])=>pair(id,label)).join('');
  document.querySelector('#search-pair').innerHTML=pair('search','Search','search');
  document.querySelector('#overview-pair').innerHTML=pair('overview','Overview','overview');
  document.querySelectorAll('iframe[data-screen]').forEach(n=>{n.src=`mockup.html?${new URLSearchParams({platform:n.dataset.platform,screen:n.dataset.screen,theme,variant:n.dataset.variant||'main'})}`;});
  document.querySelectorAll('[data-phone]').forEach(n=>{n.href=`mockup.html?platform=ios&screen=${n.dataset.phone}&theme=${theme}`;});
  document.querySelectorAll('[data-large]').forEach(n=>{n.href=`mockup.html?platform=ios&screen=${n.dataset.large}&theme=${theme}&text=largest`;});
  document.querySelectorAll('[data-sheet]').forEach(n=>{n.href=`png/after-phone-${n.dataset.sheet}-${theme}.png`;});
  document.querySelector('[data-today-search]').href=`png/before-web-search-${theme}.png`;
  document.querySelector('[data-phone-variant]').href=`mockup.html?platform=ios&screen=search&variant=search&theme=${theme}`;
  document.querySelector('[data-chat-search]').href=`mockup.html?platform=ios&screen=chat&variant=search&theme=${theme}`;
}
document.querySelector('#theme').addEventListener('click',()=>{theme=theme==='light'?'dark':'light';render();});
render();
