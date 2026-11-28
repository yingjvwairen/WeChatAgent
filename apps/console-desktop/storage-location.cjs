const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { Composer, CST, Parser, visit } = require('yaml');
const dshPatchFile = 'cordis.patch.yml';
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (base, file) =>
  same(base, file) ||
  path
    .resolve(file)
    .toLowerCase()
    .startsWith(path.resolve(base).toLowerCase() + path.sep);
const json = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw Error('本机数据文件格式无效：' + path.basename(file) + '。原文件已保留。');
  }
};
const existsConfig = home =>
  typeof home === 'string' && fs.existsSync(path.join(home, 'workspace/config/wechatagent.json'));
const atomic = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
};
function windowsEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  env.PSModulePath =
    path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') +
    (process.env.ProgramFiles ? ';' + path.join(process.env.ProgramFiles, 'WindowsPowerShell/Modules') : '');
  return env;
}
function noLinks(file) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    let stat;
    try {
      stat = fs.lstatSync(p);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat?.isSymbolicLink()) throw Error('数据目录不能通过符号链接或目录联接访问。');
    if (path.dirname(p) === p) break;
  }
}
function validateLocation(appDir, dataHome) {
  if (
    typeof dataHome !== 'string' ||
    !path.isAbsolute(dataHome) ||
    /[\0\r\n]/.test(dataHome) ||
    same(dataHome, path.parse(dataHome).root)
  )
    throw Error('请选择有效的数据文件夹，不能使用磁盘根目录。');
  if (within(appDir, dataHome) || within(dataHome, appDir))
    throw Error('程序目录与数据目录必须分开，不能互相包含，以免卸载时删除数据。');
  noLinks(dataHome);
  for (const name of ['workspace', 'runtimes', 'desktop', 'dsh']) noLinks(path.join(dataHome, name));
  return path.resolve(dataHome);
}
function resolveStorageLocation({ appDir, legacyHome, override } = {}) {
  let values = {};
  const file = path.join(appDir, 'storage.ini');
  if (fs.existsSync(file)) {
    const bytes = fs.readFileSync(file),
      text = bytes[0] === 255 && bytes[1] === 254 ? bytes.toString('utf16le') : bytes.toString('utf8');
    let active = false;
    for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) {
        active = /^\[Storage\]$/i.test(line);
        continue;
      }
      if (!active) continue;
      const m = /^(dataHome|migrationSource)=(.*)$/i.exec(line);
      if (m) values[m[1].toLowerCase() === 'datahome' ? 'dataHome' : 'migrationSource'] = m[2].trim();
    }
  }
  const fallback =
    path.basename(appDir).toLowerCase() === 'app' ? path.join(path.dirname(appDir), 'data') : appDir + '-data';
  const dataHome = validateLocation(appDir, override || values.dataHome || fallback);
  const migrationSource = override
    ? ''
    : Object.hasOwn(values, 'migrationSource')
      ? values.migrationSource
      : existsConfig(legacyHome) && !same(legacyHome, dataHome)
        ? legacyHome
        : '';
  if (migrationSource && (!path.isAbsolute(migrationSource) || /[\0\r\n]/.test(migrationSource)))
    throw Error('旧数据目录无效，请重新选择安装位置。');
  return { appDir: path.resolve(appDir), dataHome, legacyHome, migrationSource };
}
function rebasePath(value, mappings) {
  if (typeof value !== 'string') return value;
  for (const [from, to] of mappings) {
    if (path.isAbsolute(value) && within(from, value)) return path.join(to, path.relative(from, value));
    const url = pathToFileURL(from).href.replace(/\/$/, '');
    if (value.toLowerCase() === url.toLowerCase() || value.toLowerCase().startsWith(url.toLowerCase() + '/'))
      return pathToFileURL(to).href.replace(/\/$/, '') + value.slice(url.length);
  }
  return value;
}
const pathKey =
  /^(?:path|file|filename|filePath|sourcePath|targetPath|cachePath|imagePath|directory|root|projectRoot|project_root|cwd|python|node|dsh|dshDesktop|wechatExecutable|statePath|stateFile|dataHome|tokenFile|outgoingPath|modelDirectory|profiles|gptWeights|sovitsWeights|refAudio)$/i;
function rebaseJson(value, mappings, key = '', databaseBase = mappings[0][0]) {
  if (
    key === 'dbPath' &&
    typeof value === 'string' &&
    value &&
    !path.isAbsolute(value) &&
    !/^(?:safe:|userdpapi:)/.test(value)
  )
    return path.resolve(databaseBase, value);
  if (typeof value === 'string') return pathKey.test(key) ? rebasePath(value, mappings) : value;
  if (Array.isArray(value)) return value.map(item => rebaseJson(item, mappings, key, databaseBase));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebaseJson(v, mappings, k, databaseBase)]));
  return value;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const data of fs.createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
function legacyPluginBackupLink(relative, source, target) {
  if (!/(?:^|\/)dsh\/dsh-social-bridge-plugin\.original-link$/i.test(relative.replaceAll('\\', '/'))) return false;
  const resolved = path.resolve(path.dirname(source), target);
  return (
    path.basename(resolved).toLowerCase() === 'dsh-social-bridge-plugin' &&
    path.basename(path.dirname(resolved)).toLowerCase() === 'packages'
  );
}
async function copyVerified(
  source,
  target,
  {
    filter = () => true,
    records = [],
    relative = '',
    allowInternalLinks = false,
    archiveLink = async () => false,
    externalLinkAllowed = () => false,
    sourceBase = source,
    visited = new Set(),
  } = {},
) {
  const stat = await fs.promises.lstat(source);
  if (!filter(relative, stat)) return records;
  if (stat.isSymbolicLink()) {
    if (await archiveLink(source, relative)) return records;
    if (!allowInternalLinks) throw Error('旧数据中存在未支持的目录联接：' + source + '。迁移已停止，原数据保留。');
    const real = await fs.promises.realpath(source);
    if (!within(sourceBase, real)) {
      if (externalLinkAllowed(real)) return records;
      throw Object.assign(
        Error('旧 DSH 中存在指向外部数据的链接，请核对后再迁移，原数据保留。\n' + source + ' → ' + real),
        { code: 'DSH_EXTERNAL_LINK' },
      );
    }
    if (visited.has(real)) throw Error('旧 DSH 数据中存在循环链接，原数据保留。');
    return copyVerified(real, target, {
      filter,
      records,
      relative,
      allowInternalLinks,
      archiveLink,
      externalLinkAllowed,
      sourceBase,
      visited: new Set([...visited, real]),
    });
  }
  if (stat.isDirectory()) {
    await fs.promises.mkdir(target, { recursive: true });
    for (const name of await fs.promises.readdir(source))
      await copyVerified(path.join(source, name), path.join(target, name), {
        filter,
        records,
        relative: relative ? relative + '/' + name : name,
        allowInternalLinks,
        archiveLink,
        externalLinkAllowed,
        sourceBase,
        visited,
      });
  } else if (stat.isFile()) {
    const digest = await hashFile(source);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(source, target);
    if ((await hashFile(target)) !== digest || (await hashFile(source)) !== digest)
      throw Error('复制校验失败或旧数据仍在变化，尚未切换数据目录。');
    records.push({ source, target, digest });
  } else throw Error('旧数据包含不支持的文件类型，原数据保留。');
  return records;
}
function rebaseYamlValue(value, mappings) {
  let url;
  let source = value;
  if (/^file:/i.test(value)) {
    try {
      url = new URL(value);
      source = fileURLToPath(url);
    } catch {
      return value;
    }
  }
  if (!path.isAbsolute(source)) return value;
  let target = rebasePath(source, mappings);
  if (target === source) return value;
  const trailingSeparator = /[\\/]$/.exec(source)?.[0];
  if (trailingSeparator && !/[\\/]$/.test(target)) target += trailingSeparator;
  if (!url) return value.includes('\\') ? target : target.replaceAll('\\', '/');
  const rebased = pathToFileURL(target);
  rebased.search = url.search;
  rebased.hash = url.hash;
  return rebased.href;
}
function rebaseYamlPaths(text, mappings) {
  const tokens = [...new Parser().parse(text)];
  const documents = [...new Composer({ keepSourceTokens: true, prettyErrors: false }).compose(tokens)];
  if (documents.length !== 1 || documents[0].errors.length) return text;
  const orderedMappings = [...mappings].sort(([a], [b]) => b.length - a.length);
  let changed = false;
  // Only replace path scalars. Keep the surrounding document, including comments and anchors, intact.
  visit(documents[0], {
    Scalar(key, node, ancestors) {
      if (typeof node.value !== 'string' || !node.srcToken) return;
      const next = rebaseYamlValue(node.value, orderedMappings);
      if (next === node.value) return;
      CST.setScalarValue(node.srcToken, next, {
        afterKey: key === 'value',
        implicitKey: key === 'key',
        inFlow: ancestors.some(parent => parent.flow),
      });
      changed = true;
    },
  });
  return changed ? tokens.map(token => CST.stringify(token)).join('') : text;
}
async function rewriteYamlFile(file, mappings) {
  const text = fs.readFileSync(file, 'utf8');
  const next = rebaseYamlPaths(text, mappings);
  if (next !== text) await fs.promises.writeFile(file, next);
}
async function rewriteTree(directory, mappings, { yaml = false, databaseBase = mappings[0][0] } = {}) {
  if (!fs.existsSync(directory)) return;
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await rewriteTree(file, mappings, { yaml, databaseBase });
    else if (entry.name.endsWith('.json')) {
      const before = json(file),
        after = rebaseJson(before, mappings, '', databaseBase);
      if (JSON.stringify(before) !== JSON.stringify(after)) atomic(file, after);
    } else if (yaml && /\.ya?ml$/.test(entry.name)) await rewriteYamlFile(file, mappings);
  }
}
async function assertMigrationIdle({ source, config, oldDshHome, dshRetained }) {
  if (process.platform !== 'win32') return;
  const exe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const code =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);@(Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object {$_.Name -in @('WeChatAgent.exe','WeChatAgentDesktop.exe','Weixin.exe','node.exe','python.exe','DeepSeek Harness.exe')}|Select-Object Name,ProcessId,ExecutablePath,CommandLine)|ConvertTo-Json -Compress";
  const output = await new Promise((resolve, reject) =>
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-Command', code],
      { env: windowsEnv(), windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      (error, out) =>
        error ? reject(Error('无法核对旧程序是否已经退出，请退出旧版本、匹配微信和 DSH 后重试。')) : resolve(out),
    ),
  );
  let items;
  try {
    items = JSON.parse(output || '[]');
  } catch {
    throw Error('进程检查失败，旧数据尚未迁移。');
  }
  const dsh = config.runtime?.dshDesktop;
  const desktopPids = new Set();
  for (const relative of ['desktop/runtime.json', 'workspace/state/desktop/runtime.json']) {
    const record = path.join(source, relative);
    if (fs.existsSync(record))
      try {
        desktopPids.add(json(record).pid);
      } catch {}
  }
  for (const item of Array.isArray(items) ? items : [items]) {
    if (item.ProcessId === process.pid) continue;
    const command = (item.CommandLine || '').toLowerCase();
    const oldDesktop =
      desktopPids.has(item.ProcessId) && ['WeChatAgent.exe', 'WeChatAgentDesktop.exe'].includes(item.Name);
    const isDsh =
      item.Name === 'DeepSeek Harness.exe' || (dsh && item.ExecutablePath && same(item.ExecutablePath, dsh));
    const oldService =
      !(dshRetained && isDsh) &&
      ((item.ExecutablePath && within(source, item.ExecutablePath)) ||
        command.includes(path.join(source, 'workspace').toLowerCase()));
    const activeDsh = !dshRetained && (isDsh || (oldDshHome && command.includes(oldDshHome.toLowerCase())));
    if (oldDesktop || oldService || activeDsh)
      throw Error('旧实例仍在运行。请停止旧版服务，并从托盘退出匹配微信和 DSH 后重试迁移。');
  }
}
function migrationPlan(location, { legacyDshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh') } = {}) {
  const { dataHome } = location,
    marker = path.join(dataHome, '.wechatagent-data.json');
  if (fs.existsSync(marker)) {
    const state = json(marker);
    if (state.version !== 1) throw Error('数据目录标记无效。');
    return { ...location, needed: false, report: state };
  }
  const source = location.migrationSource;
  if (
    fs.existsSync(path.join(dataHome, 'workspace')) &&
    (!source || !same(source, dataHome)) &&
    (!location.legacyHome || !same(location.legacyHome, dataHome))
  )
    throw Error('目标已有未确认的数据，不能合并覆盖。请重新选择空的数据目录。');
  if (!source || same(source, dataHome)) return { ...location, needed: false };
  if (!existsConfig(source)) throw Error('无法读取旧数据目录的配置，请确认来源可用后重试迁移。');
  if (within(source, dataHome) || within(dataHome, source)) throw Error('新旧数据目录不能互相包含。');
  if (fs.existsSync(path.join(dataHome, 'workspace')))
    throw Error('目标已有未确认的数据，不能合并覆盖。请重新选择空的数据目录。');
  noLinks(source);
  for (const name of ['workspace', 'workspace/config', 'workspace/state', 'workspace/state/runtime.json'])
    noLinks(path.join(source, name));
  const config = json(path.join(source, 'workspace/config/wechatagent.json')),
    distributionFile = path.join(source, 'workspace/config/distribution.json'),
    distribution = fs.existsSync(distributionFile) ? json(distributionFile) : {};
  const boundDsh = !!distribution.dsh && same(config.runtime?.dshDesktop || '', distribution.dsh);
  const managedDsh = boundDsh && distribution.dshBundled !== false;
  const oldDshHome = boundDsh ? distribution.dshHome || legacyDshHome : distribution.externalDshHome || legacyDshHome;
  return {
    ...location,
    needed: true,
    source,
    config,
    distribution,
    managedDsh,
    oldDshHome,
    migrateDsh: managedDsh && fs.existsSync(oldDshHome),
  };
}
function retainDsh(plan) {
  return { ...plan, migrateDsh: false, dshRetained: true };
}
function deploymentStorageOptions(report, dataHome) {
  if (!report?.source) return {};
  return {
    dshHome: report.dshRetained ? report.oldDshHome : report.dshCopied ? path.join(dataHome, 'dsh') : undefined,
    externalDshHome: report.dshRetained || report.managedDsh === false ? report.oldDshHome : undefined,
  };
}

async function moveMigrationDirectory(source, destination) {
  for (let retry = 0; ; retry++) {
    if (fs.existsSync(destination)) throw Error('目标目录在迁移期间发生变化，尚未覆盖任何已有数据。');
    try {
      await fs.promises.rename(source, destination);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || retry >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 30 * 2 ** retry));
    }
  }
}

async function prepareDataHome(
  plan,
  { checkIdle = assertMigrationIdle, progress = () => {}, verify = async () => {}, legacyDshHome } = {},
) {
  const home = plan.dataHome;
  noLinks(home);
  await fs.promises.mkdir(home, { recursive: true });
  const writable = path.join(home, '.write-' + crypto.randomUUID());
  await fs.promises.writeFile(writable, 'ok', { flag: 'wx' });
  await fs.promises.unlink(writable);
  if (!plan.needed) {
    if (!fs.existsSync(path.join(home, '.wechatagent-data.json')))
      atomic(path.join(home, '.wechatagent-data.json'), { version: 1, createdAt: new Date().toISOString() });
    return { migrated: false, report: plan.report };
  }
  await checkIdle(plan);
  const lock = path.join(home, '.migration.lock');
  let handle;
  try {
    handle = await fs.promises.open(lock, 'wx');
  } catch {
    throw Error('已有迁移正在进行或上次迁移被中断，请保留原数据并检查目标目录。');
  }
  const stage = path.join(home, '.migration-' + crypto.randomUUID()),
    target = path.join(stage, 'workspace'),
    records = [],
    backupLinks = [],
    publishedDesktop = [],
    published = [];
  let committed = false;
  const removeStage = async () => {
    if (!fs.existsSync(stage)) return;
    const actual = await fs.promises.realpath(stage),
      actualHome = await fs.promises.realpath(home);
    if (
      !within(actualHome, actual) ||
      same(actualHome, actual) ||
      !/^\.migration-[a-f0-9-]+$/.test(path.basename(stage)) ||
      fs.lstatSync(stage).isSymbolicLink()
    )
      throw Error('迁移临时目录校验失败，未执行清理。');
    await fs.promises.rm(stage, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  };
  try {
    progress('正在复制旧配置、会话状态、表情包和记忆；原数据将保留…');
    const sourceRoot = path.join(plan.source, 'workspace');
    for (const dir of ['config', 'roles', 'extensions', 'state'])
      if (fs.existsSync(path.join(sourceRoot, dir)))
        await copyVerified(path.join(sourceRoot, dir), path.join(target, dir), {
          records,
          relative: dir,
          filter: (relative, stat) =>
            !(plan.dshRetained && within(plan.oldDshHome, path.join(sourceRoot, relative))) &&
            !/(^|\/)(?:__pycache__|\.git)(\/|$)/.test(relative) &&
            !/^state\/(?:runtime\.json$|desktop\/runtime\.json$|desktop\/session(?:\/|$)|hook\/(?:native(?:\/|$)|wechat-[^/]+(?:\/|$)))/.test(
              relative,
            ),
        });
    if (fs.existsSync(path.join(plan.source, 'backups')))
      await copyVerified(path.join(plan.source, 'backups'), path.join(stage, 'backups'), {
        records,
        filter: relative => !(plan.dshRetained && within(plan.oldDshHome, path.join(plan.source, 'backups', relative))),
        archiveLink: async (source, relative) => {
          // Old repair backups contain a reference to the development plugin. Keep
          // that reference as data; never copy or recreate its external directory.
          const target = await fs.promises.readlink(source);
          if (!legacyPluginBackupLink(relative, source, target)) return false;
          backupLinks.push({ source, relative, target, copiedTarget: false });
          return true;
        },
      });
    if (plan.migrateDsh) {
      progress('正在复制内置 DSH 的会话和附件…');
      const coreRoots = [
        path.join(plan.source, 'runtimes'),
        path.dirname(plan.distribution.dsh),
        ...(plan.distribution.assets ? [path.join(plan.distribution.assets, 'vendor/dsh')] : []),
      ];
      await copyVerified(plan.oldDshHome, path.join(stage, 'dsh'), {
        records,
        allowInternalLinks: true,
        externalLinkAllowed: file => coreRoots.some(base => within(base, file)),
        filter: (relative, stat) =>
          !/(^|\/)(?:lock|SingletonLock|SingletonSocket|SingletonCookie|GPUCache|Cache|Code Cache)(\/|$)/.test(
            relative,
          ),
      });
    }
    await checkIdle(plan);
    for (const item of records)
      if ((await hashFile(item.source)) !== item.digest) throw Error('旧数据在迁移期间发生变化，尚未切换。');
    for (const link of backupLinks) {
      let unchanged = false;
      try {
        unchanged =
          (await fs.promises.lstat(link.source)).isSymbolicLink() &&
          (await fs.promises.readlink(link.source)) === link.target;
      } catch {}
      if (!unchanged) throw Error('旧备份联接在迁移期间发生变化：' + link.source + '。原数据保留，尚未切换。');
    }
    const mappings = [
      [sourceRoot, path.join(home, 'workspace')],
      [plan.source, home],
    ];
    if (!plan.migrateDsh) mappings.unshift([plan.oldDshHome, plan.oldDshHome]);
    if (plan.migrateDsh) mappings.push([plan.oldDshHome, path.join(home, 'dsh')]);
    await rewriteTree(target, mappings, { databaseBase: sourceRoot });
    if (plan.migrateDsh) {
      const homePatch = path.join(stage, 'dsh', dshPatchFile);
      if (fs.lstatSync(homePatch, { throwIfNoEntry: false })?.isFile()) await rewriteYamlFile(homePatch, mappings);
      await rewriteTree(path.join(stage, 'dsh/profiles'), mappings, { yaml: true });
    }
    const backupLinkFile = backupLinks.length
      ? 'backups/migration-link-references-' + path.basename(stage).slice('.migration-'.length) + '.json'
      : undefined;
    if (backupLinkFile)
      atomic(path.join(stage, backupLinkFile), { version: 1, policy: 'reference-only', links: backupLinks });
    const cfg = json(path.join(target, 'config/wechatagent.json'));
    if (!cfg.runtime || !cfg.persona || !cfg.wechat) throw Error('旧配置无效，原数据保留。');
    if (!plan.migrateDsh) {
      // Keep only the DSH binding in place; WeChatAgent-owned paths still move.
      if (Object.hasOwn(plan.config.runtime, 'dshDesktop')) cfg.runtime.dshDesktop = plan.config.runtime.dshDesktop;
      atomic(path.join(target, 'config/wechatagent.json'), cfg);
      const file = path.join(target, 'config/distribution.json');
      if (fs.existsSync(file)) {
        const distribution = json(file);
        for (const key of ['dsh', 'dshHome', 'externalDshHome']) {
          if (Object.hasOwn(plan.distribution, key)) distribution[key] = plan.distribution[key];
          else delete distribution[key];
        }
        atomic(file, distribution);
      }
    }
    for (const name of [cfg.persona.default, ...Object.values(cfg.persona.chats || {})])
      if (typeof name !== 'string' || /[\\/]/.test(name) || !fs.existsSync(path.join(target, 'roles', name + '.md')))
        throw Error('迁移后的人设文件缺失，原数据保留。');
    await verify({ stage, workspace: target, plan });
    if (fs.existsSync(path.join(home, '.wechatagent-data.json')))
      throw Error('目标目录已被另一个实例初始化，未覆盖已有数据。');
    for (const name of [
      'workspace',
      ...(plan.migrateDsh ? ['dsh'] : []),
      ...(fs.existsSync(path.join(stage, 'backups')) ? ['backups'] : []),
    ]) {
      const destination = path.join(home, name);
      await moveMigrationDirectory(path.join(stage, name), destination);
      published.push(destination);
    }
    for (const name of ['window.json', 'background.png', 'background.jpg']) {
      const source = [path.join(plan.source, 'desktop', name), path.join(home, 'workspace/state/desktop', name)].find(
        file => fs.existsSync(file),
      );
      const destination = path.join(home, 'desktop', name);
      if (!source || fs.existsSync(destination)) continue;
      noLinks(destination);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      publishedDesktop.push({ file: destination, copied: fs.lstatSync(destination) });
    }
    const report = {
      version: 1,
      source: plan.source,
      oldDshHome: plan.oldDshHome,
      managedDsh: plan.managedDsh,
      migratedAt: new Date().toISOString(),
      verifiedFiles: records.length,
      dshCopied: plan.migrateDsh,
      oldDataRetained: true,
      ...(plan.dshRetained ? { dshRetained: true } : {}),
      ...(backupLinkFile ? { archivedBackupLinks: backupLinks.length, backupLinkFile } : {}),
    };
    atomic(path.join(home, '.wechatagent-data.json'), report);
    committed = true;
    try {
      atomic(path.join(home, 'backups/migration.json'), report);
    } catch {
      /* The committed marker already retains the complete report. */
    }
    await removeStage().catch(() => {});
    progress('旧数据已复制并校验完成，正在准备新版运行环境…');
    return { migrated: true, report };
  } catch (error) {
    if (!committed) {
      let recovered = true;
      for (const { file, copied } of publishedDesktop.reverse()) {
        try {
          noLinks(file);
          const current = fs.lstatSync(file, { throwIfNoEntry: false });
          if (
            current &&
            current.dev === copied.dev &&
            current.ino === copied.ino &&
            current.size === copied.size &&
            current.mtimeMs === copied.mtimeMs &&
            current.ctimeMs === copied.ctimeMs
          )
            fs.unlinkSync(file);
        } catch {
          recovered = false;
        }
      }
      for (const folder of published.reverse())
        if (within(home, folder) && !same(home, folder))
          await moveMigrationDirectory(folder, path.join(stage, path.basename(folder))).catch(() => {
            recovered = false;
          });
      if (recovered) await removeStage().catch(() => {});
    }
    throw error;
  } finally {
    await handle.close();
    await fs.promises.unlink(lock).catch(() => {});
  }
}
async function stageDshConfig(file, bytes, mode, publish) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode, flush: true });
    return await publish(temporary);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}
function replaceDshProfile(file, bytes, expected) {
  noLinks(file);
  const { mode } = fs.lstatSync(file);
  return stageDshConfig(file, bytes, mode, temporary => {
    noLinks(file);
    if (!fs.readFileSync(file).equals(expected)) return false;
    fs.renameSync(temporary, file);
    return true;
  });
}
async function saveDshBackup(file, bytes) {
  if (fs.existsSync(file)) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await stageDshConfig(file, bytes, 0o600, temporary =>
    fs.promises.copyFile(temporary, file, fs.constants.COPYFILE_EXCL),
  );
}
async function rebindExternalDsh(report, newRoot, dataHome) {
  if (!report?.source || report.dshRetained || report.managedDsh || !report.oldDshHome) return;
  const profiles = path.join(report.oldDshHome, 'profiles');
  const backupDirectory = path.join(dataHome, 'backups/external-dsh');
  const homePatch = path.join(report.oldDshHome, dshPatchFile);
  const configs = [];
  if (fs.lstatSync(homePatch, { throwIfNoEntry: false })?.isFile())
    configs.push([homePatch, path.join(backupDirectory, dshPatchFile)]);
  if (fs.existsSync(profiles))
    for (const entry of await fs.promises.readdir(profiles, { withFileTypes: true }))
      if (entry.isDirectory())
        for (const name of ['cordis.yml', dshPatchFile])
          configs.push([path.join(profiles, entry.name, name), path.join(backupDirectory, entry.name, name)]);

  const mappings = [[path.join(report.source, 'workspace'), newRoot]];
  const updates = [];
  for (const [file, backup] of configs) {
    if (!fs.existsSync(file)) continue;
    noLinks(file);
    const bytes = await fs.promises.readFile(file),
      text = bytes.toString('utf8');
    const next = rebaseYamlPaths(text, mappings);
    if (next !== text) {
      await saveDshBackup(backup, bytes);
      updates.push({ file, bytes, next: Buffer.from(next) });
    }
  }
  const written = [];
  try {
    for (const item of updates) {
      if (!(await replaceDshProfile(item.file, item.next, item.bytes)))
        throw Error('DSH 配置在迁移后发生变化，请先退出 DSH 再重试。');
      written.push(item);
    }
  } catch (error) {
    let restored = true;
    for (const item of written.reverse()) {
      try {
        if (!(await replaceDshProfile(item.file, item.bytes, item.next))) restored = false;
      } catch {
        restored = false;
      }
    }
    if (!restored)
      throw Error(error.message + ' 部分 DSH 配置未回滚。原始配置备份在 ' + backupDirectory + '。', {
        cause: error,
      });
    throw error;
  }
}
async function stopLegacyServices(plan, resourcesPath) {
  if (
    !plan.needed ||
    process.platform !== 'win32' ||
    !fs.existsSync(path.join(plan.source, 'workspace/state/runtime.json'))
  )
    return;
  const exe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await new Promise((resolve, reject) =>
    execFile(
      exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(resourcesPath, 'project/scripts/stop-legacy-services.ps1'),
        '-LegacyRoot',
        path.join(plan.source, 'workspace'),
      ],
      { env: windowsEnv(), windowsHide: true, timeout: 70000, maxBuffer: 1024 * 1024 },
      error => (error ? reject(Error('未能停止旧版后台服务。旧数据仍在原处，请退出旧版服务后重试迁移。')) : resolve()),
    ),
  );
}
module.exports = {
  resolveStorageLocation,
  validateLocation,
  migrationPlan,
  retainDsh,
  deploymentStorageOptions,
  prepareDataHome,
  rebasePath,
  rebaseJson,
  assertMigrationIdle,
  rebindExternalDsh,
  stopLegacyServices,
};
