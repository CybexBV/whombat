const platforms=['desktop','phoneweb','ios','android'];
const screens=[['chat-list','Chat'],['thread','Thread'],['approval','Approval'],['inbox','Inbox'],['overview','Overview'],['connection','Connection'],['server','Server'],['automations','Automations'],['settings','Settings'],['vault','Vault'],['files','Files'],['usage','Usage'],['search','Search']];
let theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
const table=document.querySelector('#screens');
for(const [id,label] of screens) {
 const row=document.createElement('tr');row.id=id;
 const head=document.createElement('th');head.scope='row';head.innerHTML=`<strong>${label}</strong><a href="${id}/NOTES.md">NOTES.md</a>`;row.append(head);
 for(const platform of platforms) {
  const cell=document.createElement('td');const figure=document.createElement('figure');figure.className='gallery-cell pending';
  const link=document.createElement('a');link.href=`${id}/${platform}-${theme}.png`;link.setAttribute('aria-label',`${label}, ${platform}, ${theme}, open full picture`);
  const img=document.createElement('img');img.alt=`${label} · ${platform} · ${theme}`;img.loading='lazy';img.dataset.screen=id;img.dataset.platform=platform;
  img.addEventListener('load',()=>{figure.className='gallery-cell ready';link.hidden=false;});
  img.addEventListener('error',()=>{figure.className='gallery-cell coming';link.hidden=true;});
  img.src=`${id}/${platform}-${theme}.png`;
  link.append(img);figure.append(link);const coming=document.createElement('span');coming.className='placeholder';coming.textContent='coming';figure.append(coming);cell.append(figure);row.append(cell);
 }
 table.append(row);
}
function appearance(){document.documentElement.dataset.theme=theme;document.querySelector('[data-theme-toggle]').textContent=`Use ${theme==='light'?'dark':'light'} theme`;document.querySelectorAll('.gallery-cell img').forEach(img=>{const link=img.parentElement;link.hidden=false;link.href=`${img.dataset.screen}/${img.dataset.platform}-${theme}.png`;link.setAttribute('aria-label',`${img.dataset.screen}, ${img.dataset.platform}, ${theme}, open full picture`);img.alt=`${img.dataset.screen} · ${img.dataset.platform} · ${theme}`;img.src=link.href;});}
document.querySelector('[data-theme-toggle]').addEventListener('click',()=>{theme=theme==='light'?'dark':'light';appearance();});appearance();
