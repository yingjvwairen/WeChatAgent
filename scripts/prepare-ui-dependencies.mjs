import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute=promisify(execFile),rootDefault=path.resolve(import.meta.dirname,'..');
const fault=code=>Object.assign(new Error(code),{code});
function local(file){if(typeof file!=='string'||!path.isAbsolute(file)||/^[\\/]{2}/.test(file)||/[\0\r\n]/.test(file)||/(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)/i.test(file))throw fault('UI_DEPENDENCY_LOCAL_PATH_REQUIRED');for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_DEPENDENCY_LINK_REFUSED');if(path.dirname(at)===at)return path.resolve(file);}}
export function dependencyInstallSpec({root=rootDefault,environment=process.env}={}){
  root=local(root);const runtime=JSON.parse(fs.readFileSync(local(path.join(root,'state/ui-runtime.json')),'utf8').replace(/^\uFEFF/,''));
  if(runtime.schemaVersion!==1)throw fault('UI_DEPENDENCY_RUNTIME_REQUIRED');const node=local(runtime.node);
  if(!fs.statSync(node,{throwIfNoEntry:false})?.isFile())throw fault('UI_DEPENDENCY_RUNTIME_REQUIRED');
  const entries=String(environment.PATH??environment.Path??'').split(path.delimiter);
  const blockedRoots=Object.entries(environment).filter(([key,value])=>/^CODEX/i.test(key)&&typeof value==='string'&&path.isAbsolute(value)).map(([,value])=>path.resolve(value).toLowerCase());
  const independent=file=>{const full=path.resolve(file).toLowerCase();return !/(^|[\\/])(codex|openai\.codex[^\\/]*)([\\/]|$)/i.test(full)&&!blockedRoots.some(base=>full===base||full.startsWith(base+path.sep));};
  if(!independent(node))throw fault('UI_DEPENDENCY_RUNTIME_REQUIRED');
  const candidates=[path.join(path.dirname(node),'node_modules/npm/bin/npm-cli.js'),path.join(path.dirname(node),'../node_modules/npm/bin/npm-cli.js'),...entries.filter(Boolean).map(dir=>path.join(dir,'node_modules/npm/bin/npm-cli.js'))];
  const npmCli=candidates.find(file=>{try{return independent(file)&&fs.statSync(local(file),{throwIfNoEntry:false})?.isFile();}catch{return false;}});
  if(!npmCli)throw fault('UI_DEPENDENCY_NPM_REQUIRED');
  const directory=local(path.join(root,'packages/dsh-social-bridge-plugin'));for(const name of ['package.json','package-lock.json'])if(!fs.statSync(local(path.join(directory,name)),{throwIfNoEntry:false})?.isFile())throw fault('UI_DEPENDENCY_LOCKFILE_REQUIRED');
  const env=Object.fromEntries(Object.entries(environment).filter(([key])=>!/^CODEX/i.test(key)&&!['NODE_OPTIONS','NODE_PATH'].includes(key.toUpperCase())));
  env.PATH=[path.dirname(node),...entries.filter(dir=>dir&&independent(dir)&&!/(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)/i.test(dir))].join(path.delimiter);delete env.Path;
  return{exe:node,args:[path.resolve(npmCli),'ci','--prefix',directory,'--ignore-scripts','--no-audit','--no-fund'],options:{cwd:root,env,windowsHide:true,shell:false,timeout:1200000,maxBuffer:1024*1024}};
}
export async function prepareUiDependencies({root=rootDefault,executeImpl=execute,environment=process.env}={}){
  for(const relative of ['state/ui-service.lock','state/reader-service/service.lock'])if(fs.existsSync(path.join(root,relative)))throw fault('UI_DEPENDENCY_STOP_SERVICES');
  const spec=dependencyInstallSpec({root,environment});try{await executeImpl(spec.exe,spec.args,spec.options);}catch{throw fault('UI_DEPENDENCY_INSTALL_FAILED');}
  return{prepared:true,installScriptsRun:false,desktopOperated:false,servicesStarted:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareUiDependencies().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.code?.startsWith('UI_DEPENDENCY_')?error.code:'UI_DEPENDENCY_INSTALL_FAILED');process.exitCode=1;});
