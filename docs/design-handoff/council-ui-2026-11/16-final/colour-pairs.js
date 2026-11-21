// Read rendered token paint, including decorative badges excluded by text-tree sampling.
function measureControlPairs() {
 const rgb = text => {
  const parts=text.match(/[\d.]+/g)?.map(Number);
  if(!parts)return [0,0,0,0];
  const scale=text.startsWith('color(srgb ')?255:1;
  return [parts[0]*scale,parts[1]*scale,parts[2]*scale,parts[3]??1];
 };
 const over=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]+bg[i]*(1-fg[3]));
 const lum=colour=>colour.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((total,v,i)=>total+v*[.2126,.7152,.0722][i],0);
 const rows=[];
 for(const el of document.querySelectorAll('.shell-badge,.feedback-badge,.needs-cue,.places-trigger,.search-link,.send')) {
  if(!el.getClientRects().length)continue;
  const chain=[];for(let at=el;at;at=at.parentElement)chain.unshift(at);
  let background=[255,255,255];
  for(const at of chain)background=over(rgb(getComputedStyle(at).backgroundColor),background);
  const foreground=over(rgb(getComputedStyle(el).color),background);
  const a=lum(foreground),b=lum(background);
  rows.push({name:el.getAttribute('aria-label')||el.className,text:el.textContent.trim(),foreground:foreground.map(Math.round),background:background.map(Math.round),ratio:+((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toFixed(3)});
 }
 return rows;
}
