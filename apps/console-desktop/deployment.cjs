// Vendor app.asar files are opaque program files. Electron's patched fs
// interprets them as virtual directories, including incomplete destinations.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function packageFingerprint(directory) {
  const files = [];
  let entries = 0;
  function visit(folder, prefix) {
    if (!fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return false;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (++entries > 512) return false;
      const file = path.join(folder, entry.name),
        name = prefix + entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!visit(file, name + '/')) return false;
      } else if (entry.isFile()) {
        if (files.length >= 256 || fs.statSync(file).size > 8 * 1024 * 1024) return false;
        files.push([name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
      } else return false;
    }
    return true;
  }
  return visit(directory, '') ? fingerprintFiles(files) : null;
}

function fingerprintFiles(files) {
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

async function seedBuiltinPlugins(template, workspace, manifest, previousHashes) {
  const ids = manifest.builtinPlugins ?? [];
  const validId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id);
  if (!Array.isArray(ids) || ids.length > 32 || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) {
    throw new Error('发行包内置插件清单无效。');
  }
  if (!ids.length) return {};
  const plugins = path.join(workspace, 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  if (!fs.lstatSync(plugins).isDirectory() || fs.lstatSync(plugins).isSymbolicLink()) throw new Error('插件目录无效。');
  const installed = {};
  for (const id of ids) {
    const target = path.join(plugins, id);
    const prefix = 'optional-extensions/' + id + '/';
    const files = manifest.files.filter(file => file.startsWith(prefix));
    if (!files.includes(prefix + 'plugin.json') || !files.includes(prefix + 'index.mjs'))
      throw new Error('发行包内置插件文件不完整。');
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    const nextHash = fingerprintFiles(files.map(file => [file.slice(prefix.length), manifest.sourceHashes?.[file]]));
    if (existing) {
      const current = packageFingerprint(target);
      if (current === nextHash) {
        installed[id] = nextHash;
        continue;
      }
      if (!current || current !== previousHashes[id]) continue; // Locally installed or modified package.
    }
    // Stage on the same volume and publish the complete package in one rename.
    const scratch = path.join(workspace, 'state');
    fs.mkdirSync(scratch, { recursive: true });
    if (!fs.lstatSync(scratch).isDirectory() || fs.lstatSync(scratch).isSymbolicLink())
      throw new Error('插件暂存目录无效。');
    const temporary = fs.mkdtempSync(path.join(scratch, 'builtin-plugin-'));
    try {
      for (const file of files) {
        const bytes = fs.readFileSync(path.join(template, file));
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sourceHashes?.[file])
          throw new Error('内置插件校验失败。');
        const destination = path.resolve(temporary, file.slice(prefix.length));
        if (!destination.startsWith(temporary + path.sep)) throw new Error('内置插件路径无效。');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes, { flag: 'wx' });
      }
      const item = JSON.parse(fs.readFileSync(path.join(temporary, 'plugin.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (item.id !== id || item.host !== 'wechatagent' || item.apiVersion !== 2) throw new Error('内置插件身份无效。');
      const archive = existing ? path.join(scratch, 'plugin-archives', id + '-' + crypto.randomUUID()) : null;
      if (archive) {
        fs.mkdirSync(path.dirname(archive), { recursive: true });
        if (!fs.lstatSync(path.dirname(archive)).isDirectory()) throw Error('插件归档目录无效。');
        fs.renameSync(target, archive);
      }
      try {
        fs.renameSync(temporary, target);
      } catch (error) {
        if (archive) fs.renameSync(archive, target);
        throw error;
      }
      installed[id] = nextHash;
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return installed;
}

async function bootstrapDeployment(resourcesPath, dataHome, progress = () => {}, options = {}) {
  const template = path.join(resourcesPath, 'project'),
    manifestFile = path.join(template, 'deployment.json');
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const { wechatVersion } = JSON.parse(fs.readFileSync(path.join(template, 'release-profile.json'), 'utf8'));
  if (
    manifest.desktopRuntime !== true ||
    typeof wechatVersion !== 'string' ||
    !/^\d+(\.\d+){3}$/u.test(wechatVersion) ||
    manifest.wechatVersion !== wechatVersion ||
    !Array.isArray(manifest.files) ||
    !manifest.files.includes('release-profile.json') ||
    !Array.isArray(manifest.bundledWechatVersions) ||
    manifest.bundledWechatVersions.length
  )
    throw Error('发行包桌面运行环境或微信版本无效。');
  const workspace = path.join(dataHome, 'workspace'),
    distributionFile = path.join(workspace, 'config/distribution.json');
  const previous = fs.existsSync(distributionFile)
    ? JSON.parse(fs.readFileSync(distributionFile, 'utf8').replace(/^\uFEFF/, ''))
    : {};
  const configFile = path.join(workspace, 'config/wechatagent.json');
  const config = JSON.parse(
    fs
      .readFileSync(
        fs.existsSync(configFile) ? configFile : path.join(template, 'config/wechatagent.example.json'),
        'utf8',
      )
      .replace(/^\uFEFF/, ''),
  );
  if (config.runtime?.sender !== 'wechat-ui')
    throw Error('请选择新的数据目录配置桌面发送。当前数据目录使用其他发送后端。');
  const previousHashes = { ...previous.builtinPluginHashes };
  for (const id of previous.builtinPlugins ?? []) {
    if (/^[a-z][a-z0-9-]{0,39}$/.test(id) && !previousHashes[id]) {
      previousHashes[id] = packageFingerprint(path.join(workspace, 'optional-extensions', id));
    }
  }
  const externalDshHome =
    options.externalDshHome ||
    previous.externalDshHome ||
    process.env.DSH_HOME ||
    path.join(require('node:os').homedir(), '.dsh');
  const dshHome = options.dshHome || previous.dshHome || externalDshHome;
  fs.mkdirSync(workspace, { recursive: true });
  for (const relative of manifest.files) {
    if (
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).includes('..') ||
      relative.startsWith('state/') ||
      relative === 'config/wechatagent.json'
    )
      throw Error('发行包文件清单无效。');
    const source = path.join(template, relative),
      target = path.join(workspace, relative);
    if (relative.startsWith('roles/')) {
      if (fs.existsSync(target)) continue;
      const name = path.basename(relative, '.md'),
        key = crypto.createHash('sha256').update(name.toLocaleLowerCase()).digest('hex');
      try {
        const marker = JSON.parse(
          fs.readFileSync(path.join(workspace, 'state/deleted-personas', key + '.json'), 'utf8'),
        );
        if (marker.version === 1 && marker.name?.toLocaleLowerCase() === name.toLocaleLowerCase()) continue;
      } catch {}
    }
    const bytes = fs.readFileSync(source),
      hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (manifest.sourceHashes?.[relative] && hash !== manifest.sourceHashes[relative])
      throw Error('发行包文件校验失败。');
    if (fs.existsSync(target) && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === hash)
      continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const runtimeName = manifest.runtimeRevision ? `${manifest.version}-${manifest.runtimeRevision}` : manifest.version;
  const versionRuntime = path.join(dataHome, 'runtimes', runtimeName),
    ready = path.join(versionRuntime, '.ready');
  if (!fs.existsSync(ready)) {
    fs.mkdirSync(versionRuntime, { recursive: true });
    progress('正在准备本机 Python、OCR 与 Node.js 运行环境…');
    for (const name of ['python', 'ocr'])
      await fs.promises.cp(path.join(resourcesPath, 'runtime', name), path.join(versionRuntime, name), {
        recursive: true,
      });
    fs.copyFileSync(path.join(resourcesPath, 'runtime/node.exe'), path.join(versionRuntime, 'node.exe'));
    fs.writeFileSync(ready, manifest.version);
  }
  const python = path.join(versionRuntime, 'python/python.exe'),
    ocrPython = path.join(versionRuntime, 'ocr/python.exe'),
    node = path.join(versionRuntime, 'node.exe');
  const modelDirectory = path.join(workspace, 'state/ocr/models');
  fs.mkdirSync(modelDirectory, { recursive: true });
  await fs.promises.cp(path.join(resourcesPath, 'runtime/ocr-models'), modelDirectory, { recursive: true });
  const keyBytes = fs.readFileSync(path.join(resourcesPath, 'runtime/reader-key/wx_key.dll'));
  if (
    keyBytes.length !== manifest.readerKey?.bytes ||
    crypto.createHash('sha256').update(keyBytes).digest('hex') !== manifest.readerKey?.sha256
  )
    throw Error('读取配置组件校验失败。');
  const keyTarget = path.join(workspace, 'components/weflow-cli/resources/key/win32/x64/wx_key.dll');
  fs.mkdirSync(path.dirname(keyTarget), { recursive: true });
  fs.writeFileSync(keyTarget, keyBytes);
  progress('正在准备桌面控件与录音组件…');
  const nativeDirectory = path.join(workspace, 'state/ui-host');
  fs.mkdirSync(nativeDirectory, { recursive: true });
  if (!manifest.nativeHashes || !Object.keys(manifest.nativeHashes).length) throw Error('发行包缺少桌面组件。');
  for (const [name, expected] of Object.entries(manifest.nativeHashes)) {
    if (!/^[A-Za-z0-9-]+\.exe$/.test(name) || !/^[a-f0-9]{64}$/.test(expected)) throw Error('桌面组件清单无效。');
    const bytes = fs.readFileSync(path.join(resourcesPath, 'desktop-native', name));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('桌面组件校验失败。');
    const target = path.join(nativeDirectory, name);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) fs.writeFileSync(target, bytes);
  }
  if (!fs.existsSync(configFile) || config.runtime.python === previous.python) config.runtime.python = python;
  config.input ??= {};
  if (
    !config.input.python ||
    config.input.python === previous.desktopPython ||
    config.input.python === previous.foregroundInputPython
  )
    config.input.python = python;
  config.input.expectedVersion = wechatVersion;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  if (manifest.buildId && previous.buildId && previous.buildId !== manifest.buildId) {
    const pendingFile = path.join(workspace, 'state/console-state.json');
    let pending = {};
    try {
      pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } catch {}
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile, JSON.stringify({ ...pending, pendingApply: true, dshRestartRequired: true }));
  }
  const builtinPluginHashes = await seedBuiltinPlugins(template, workspace, manifest, previousHashes);
  const builtinPlugins = Object.keys(builtinPluginHashes);
  fs.writeFileSync(
    distributionFile,
    JSON.stringify(
      {
        version: manifest.version,
        buildId: manifest.buildId,
        builtAt: manifest.builtAt,
        runtimeRevision: manifest.runtimeRevision,
        desktopRuntime: true,
        wechatVersion,
        bundledWechatVersions: [],
        installed: true,
        dataHome,
        python,
        desktopPython: python,
        foregroundInputPython: python,
        ocrPython,
        node,
        dshBundled: false,
        dsh: previous.dsh || '',
        dshHome,
        externalDshHome,
        assets: resourcesPath,
        builtinPlugins,
        builtinPluginHashes,
      },
      null,
      2,
    ),
  );
  progress('本机运行环境已准备，请在连接设置选择已安装的微信与 DSH。');
  return { root: workspace, node, python, dataHome, version: manifest.version };
}
module.exports = { bootstrapDeployment };
