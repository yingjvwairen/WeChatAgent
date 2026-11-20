// Vendor app.asar files are opaque program files. Electron's patched fs
// interprets them as virtual directories, including incomplete destinations.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function bootstrapDeployment(resourcesPath, dataHome, progress = () => {}, options = {}) {
  const template = path.join(resourcesPath, 'project');
  const manifestFile = path.join(template, 'deployment.json');
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const dshBundled = manifest.dshBundled !== false;
  const workspace = path.join(dataHome, 'workspace');
  const previousDistribution=path.join(workspace,'config/distribution.json');
  const previousSettings=fs.existsSync(previousDistribution)?JSON.parse(fs.readFileSync(previousDistribution,'utf8').replace(/^\uFEFF/,'')):{};
  const externalDshHome=options.externalDshHome || previousSettings.externalDshHome || process.env.DSH_HOME || path.join(require('node:os').homedir(),'.dsh');
  const dshHome=options.dshHome || previousSettings.dshHome || (dshBundled && !fs.existsSync(path.join(workspace,'config/wechatagent.json')) ? path.join(dataHome,'dsh') : externalDshHome);
  fs.mkdirSync(workspace, { recursive: true });
  for (const relative of manifest.files) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.startsWith('state/') || relative === 'config/wechatagent.json') throw new Error('发行包文件清单无效。');
    const source = path.join(template, relative), target = path.join(workspace, relative);
    if (relative.startsWith('roles/')) {
      if (fs.existsSync(target)) continue;
      const name=path.basename(relative,'.md'),key=crypto.createHash('sha256').update(name.toLocaleLowerCase()).digest('hex');
      const marker=path.join(workspace,'state','deleted-personas',key+'.json');
      try {
        const record=JSON.parse(fs.readFileSync(marker,'utf8'));
        if(record.version===1&&typeof record.name==='string'&&record.name.toLocaleLowerCase()===name.toLocaleLowerCase())continue;
      } catch { /* Missing/invalid markers retain the existing seed behaviour. */ }
    }
    const bytes = fs.readFileSync(source);
    if (fs.existsSync(target) && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === crypto.createHash('sha256').update(bytes).digest('hex')) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  const bundledPython=fs.existsSync(path.join(resourcesPath,'runtime','python','python.exe'));
  const runtimeName = manifest.runtimeRevision ? `${manifest.version}-${manifest.runtimeRevision}` : manifest.version;
  const versionRuntime = path.join(dataHome, 'runtimes', runtimeName);
  const ready = path.join(versionRuntime, '.ready');
  if (!fs.existsSync(ready)) {
    fs.mkdirSync(versionRuntime, { recursive: true });
    if(bundledPython)await fs.promises.cp(path.join(resourcesPath,'runtime','python'),path.join(versionRuntime,'python'),{recursive:true});
    progress(dshBundled?'正在准备 Node.js 与模型程序…':'正在准备 Node.js 运行环境…');
    fs.copyFileSync(path.join(resourcesPath, 'runtime', 'node.exe'), path.join(versionRuntime, 'node.exe'));
    if(dshBundled)await fs.promises.cp(path.join(resourcesPath, 'vendor', 'dsh'), path.join(versionRuntime, 'dsh'), { recursive: true });
    fs.writeFileSync(ready, manifest.version);
  }
  const python = bundledPython ? path.join(versionRuntime,'python','python.exe') : 'python';
  const node = path.join(versionRuntime, 'node.exe');
  // Keep an existing legacy executable/data binding; new installations choose
  // an independently installed DSH through the setup page.
  const dsh = dshBundled ? path.join(versionRuntime,'dsh','DeepSeek Harness.exe') : previousSettings.dsh || '';
  for (const [relative,expectedHash] of Object.entries(manifest.nativeFiles ?? {})) {
    if (!/^(?:ui-host\/Wechat[A-Za-z]+|audio-probe\/AudioRouteProbe)\.exe$/.test(relative) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('发行包的本机组件清单无效。');
    const source=path.join(resourcesPath,'vendor','ui',relative),target=path.join(workspace,'state',relative);
    const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const bytes=fs.readFileSync(source);
    if(sha(bytes)!==expectedHash)throw Error('发行包的本机组件校验失败。');
    if(fs.existsSync(target)&&sha(fs.readFileSync(target))===expectedHash)continue;
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const temporary=target+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,bytes,{flag:'wx'});fs.renameSync(temporary,target);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  const configFile = path.join(workspace, 'config', 'wechatagent.json');
  if (!fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(path.join(workspace, 'config', 'wechatagent.example.json'), 'utf8'));
    config.runtime.python = python;
    config.runtime.dshDesktop = dshBundled ? dsh : '';
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  }
  const distributionFile = path.join(workspace, 'config', 'distribution.json');
  if (fs.existsSync(distributionFile)) {
    const previous = JSON.parse(fs.readFileSync(distributionFile, 'utf8'));
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (config.runtime.python === previous.python) config.runtime.python = python;
    if (dshBundled && config.runtime.dshDesktop === previous.dsh) config.runtime.dshDesktop = dsh;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    if (manifest.buildId && previous.buildId !== manifest.buildId) {
      const pendingFile = path.join(workspace, 'state', 'console-state.json');
      let pending = {}; try { pending = JSON.parse(fs.readFileSync(pendingFile,'utf8')); } catch {}
      fs.writeFileSync(pendingFile,JSON.stringify({...pending,pendingApply:true,dshRestartRequired:true},null,2));
    }
  }
  fs.writeFileSync(distributionFile, JSON.stringify({
    version: manifest.version, buildId: manifest.buildId, builtAt: manifest.builtAt,
    runtimeRevision: manifest.runtimeRevision, installed: true, dataHome, python, node,
    dshBundled, dsh, dshHome, externalDshHome, assets: resourcesPath,
  }, null, 2));
  if(manifest.nativeFiles){
    const {pathToFileURL}=require('node:url');
    const {migrateRetiredSender}=await import(pathToFileURL(path.join(workspace,'scripts/project-config.mjs')).href);
    const {syncInstalledUiRuntime}=await import(pathToFileURL(path.join(workspace,'scripts/installed-ui-runtime.mjs')).href);
    const settings=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
    if(migrateRetiredSender(settings))fs.writeFileSync(configFile,JSON.stringify(settings,null,2)+'\n');
    syncInstalledUiRuntime(workspace,settings);
  }
  progress('本机运行环境已准备，正在打开控制台…');
  return { root: workspace, node, python, dataHome, version: manifest.version };
}
module.exports = { bootstrapDeployment };
