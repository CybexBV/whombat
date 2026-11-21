import {readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve('tools/visual/package.json'));
const {PNG}=require('pngjs');
let before=0,after=0;
for(const name of (await readdir(new URL('png/',import.meta.url))).filter(n=>n.endsWith('.png'))){
  const path=new URL('png/'+name,import.meta.url),old=await readFile(path);
  const png=PNG.sync.read(old),compressed=PNG.sync.write(png,{colorType:2,deflateLevel:9,deflateStrategy:3});
  before+=old.length;
  if(compressed.length<old.length)await writeFile(path,compressed);
  after+=(await readFile(path)).length;
  await copyFile(path,resolve('.whombat/shots',name));
}
console.log(JSON.stringify({beforeBytes:before,afterBytes:after}));
