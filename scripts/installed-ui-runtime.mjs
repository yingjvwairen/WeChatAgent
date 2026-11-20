import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Installed copies use the selected DSH Python 3.12 for isolated media and
 * Reader environments; the embedded console Node can start before setup. */
export function syncInstalledUiRuntime(root,config) {
  const dist=path.join(root,'config/distribution.json');
  const desktop=config?.runtime?.dshDesktop;
  if(!desktop||!fs.existsSync(dist)||JSON.parse(fs.readFileSync(dist,'utf8').replace(/^\uFEFF/,'')).installed!==true)return false;
  if(!path.isAbsolute(desktop)||/^[\\/]{2}/.test(desktop)||!fs.statSync(desktop,{throwIfNoEntry:false})?.isFile())return false;
  const dshRoot=path.dirname(desktop),dependencies=path.join(dshRoot,'resources/runtime/primary-runtime/dependencies');
  const node=path.join(dependencies,'node/bin/node.exe'),pythonBase=path.join(dependencies,'python/python.exe');
  if(![node,pythonBase].every(file=>fs.statSync(file,{throwIfNoEntry:false})?.isFile()))return false;
  const directory=path.join(root,'state'),file=path.join(directory,'ui-runtime.json');
  for(let cursor=file;;cursor=path.dirname(cursor)){
    if(fs.lstatSync(cursor,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('UI_RUNTIME_LINK_REFUSED');
    if(cursor===path.dirname(cursor))break;
  }
  const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
  if(previous.schemaVersion===1&&previous.node===node&&previous.pythonBase===pythonBase&&previous.dshRoot===dshRoot)return false;
  fs.mkdirSync(directory,{recursive:true});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{
    fs.writeFileSync(temp,JSON.stringify({...previous,schemaVersion:1,dshRoot,node,pythonBase,configuredAt:new Date().toISOString()},null,2),{flag:'wx',mode:0o600});
    fs.renameSync(temp,file);
  }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  return true;
}
