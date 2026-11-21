const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme')==='dark'?'dark':'light';
const sheet=document.getElementById('message-actions');
let opener;
document.addEventListener('click',e=>{
  const button=e.target.closest('[data-message]');
  if(button) {
    opener=button;
    document.getElementById('actions-list').replaceChildren(...JSON.parse(button.dataset.actions).map(name=>{const b=document.createElement('button');b.textContent=name;b.addEventListener('click',()=>sheet.close());return b;}));
    button.setAttribute('aria-expanded','true');sheet.showModal();document.querySelector('#actions-list button').focus();
  }
  if(e.target.closest('[data-close]'))sheet.close();
});
sheet.addEventListener('close',()=>{opener?.setAttribute('aria-expanded','false');opener?.focus({preventScroll:true});});
sheet.addEventListener('click',e=>{if(e.target===sheet&&(e.offsetX<0||e.offsetY<0||e.offsetX>sheet.clientWidth||e.offsetY>sheet.clientHeight))sheet.close();});
if(params.get('menu')==='open')document.querySelector('[data-message]').click();
