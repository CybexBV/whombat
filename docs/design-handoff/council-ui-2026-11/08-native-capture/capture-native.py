# Fixture-only capture. Set NATIVE_CLI to the command returned by device_open.
# Android: NATIVE_PLATFORM=android; iOS: NATIVE_PLATFORM=ios.
import subprocess,pathlib,json,time,os
cli=os.environ['NATIVE_CLI']
platform=os.environ['NATIVE_PLATFORM']
largest=os.environ.get('NATIVE_LARGEST')=='1'
requested=os.environ.get('NATIVE_REQUESTED')=='1'
suffix='-requested-route' if requested else '-largest' if largest else ''
out=pathlib.Path('docs/design-handoff/council-ui-2026-11/08-native-capture')
routes=[('chat-list','chat','Send'),('thread','threads/msg_chat-memory','ZFS'),('approval','approvals/33','Yes, tonight'),('inbox','inbox','Settled'),('overview','connections','blackbox'),('connection','things/connection%3Acon_ha','Home Assistant'),('server','things/server%3Apve-02','pve-02'),('automations','automations','Automations'),('settings','settings','Settings'),('vault','vault','Add to Vault'),('files','files','Files'),('usage','spend','Today')]
if requested:
 routes=[('thread','threads/msg_chat-pve-memory','not in this conversation'),('approval','approvals/902','isn’t here any more'),('connection','things/connection%3Acon_home-assistant','isn’t one of your connections')]
def run(*a):
 p=subprocess.run([cli,*a],capture_output=True,text=True);print(p.stdout,flush=True)
 if p.returncode:raise RuntimeError(p.stderr)
 return p.stdout
record_file=out/f'{platform}{suffix}-capture.json'
records=json.loads(record_file.read_text()) if record_file.exists() else []
if largest:
 routes=[r for r in routes if r[0] in ['chat-list','thread','approval','overview']]
run('settings','text-size',('accessibility-extra-large' if platform=='android' else 'accessibility-extra-extra-extra-large') if largest else 'large')
for theme in ['light','dark']:
 run('settings','appearance',theme)
 for id,route,ready in routes:
  if any(r['id']==id and r['theme']==theme for r in records):continue
  start=time.time()
  run('open','com.whombat.mobile','--relaunch')
  if platform=='ios':
   for _ in range(25):
    initial=run('snapshot','-i')
    if 'Send' in initial:break
   else:raise RuntimeError('Demo did not start')
  run('open','com.whombat.mobile','whombat://'+route)
  if platform=='ios':
   alert=run('snapshot','-i')
   if 'Open in' in alert:run('alert','accept')
  for i in range(20):
   snapshot=run('snapshot','-i')
   if ready.lower() in snapshot.lower():break
  else:raise RuntimeError('Not ready: '+id)
  stem=f'{platform}-{id}-requested-route-{theme}' if requested else f'{platform}-{id}-{theme}{suffix}'
  (out/(stem+'.txt')).write_text(snapshot)
  name=stem+'.png';run('screenshot',str((out/'png'/name).resolve()),*(['--scale','0.3333333333333333'] if platform=='android' else []),'--normalize-status-bar')
  records.append(dict(platform=platform,id=id,theme=theme,file=name,route='whombat://'+route,elapsed=round(time.time()-start,2)))
  record_file.write_text(json.dumps(records,indent=2)+'\n')
  print('CAPTURED '+name,flush=True)
