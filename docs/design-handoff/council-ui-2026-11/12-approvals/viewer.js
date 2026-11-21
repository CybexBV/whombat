(() => {
  const q=new URLSearchParams(location.search), ids=['platform','surface','kind','state','length','text','theme'];
  for(const id of ids)if(q.has(id))document.getElementById(id).value=q.get(id);
  function render(){
    const values=Object.fromEntries(ids.map(id=>[id,document.getElementById(id).value]));
    const native=['ios','android'].includes(values.platform), phone=values.platform!=='web';
    document.documentElement.dataset.theme=values.theme;
    document.getElementById('surface').disabled=native;
    const params=new URLSearchParams({...values,platform:native?values.platform:'web',surface:native?'phone':values.surface});
    const after=document.getElementById('after');after.src=`mockup.html?${params}`;after.className=phone?'phone-frame':'';
    const before=document.getElementById('before');before.className=phone?'phone-frame':'';
    const gap=values.state!=='pending'||(values.kind==='mail'&&values.length==='long');before.hidden=gap;document.getElementById('before-gap').hidden=!gap;
    const old=new URLSearchParams({surface:native?'phone':values.surface,kind:values.kind,platform:native?values.platform:'ios',theme:values.theme});
    // Step 03's 200% stress mode is not a largest-system-text baseline.
    before.src=`../03-approvals/approvals.html?${old}`;
    document.getElementById('before-label').textContent=gap?'Before · no same-state frame here; stress captures are in local pictures':`Before · step 03 static drawing${values.text==='largest'?' · ordinary text (no equivalent max-size baseline)':''}`;
    document.getElementById('after-label').textContent=`After · ${native?values.platform+' HTML drawing':phone?'phone browser · drawer closed':'desktop web'}${values.text==='largest'?native?' · system maximum, effective 1.6×':' · 200% text':''}`;
    document.getElementById('full').href=after.src;
    history.replaceState(null,'',`?${new URLSearchParams(values)}`);
  }
  ids.forEach(id=>document.getElementById(id).addEventListener('change',render));render();
})();
