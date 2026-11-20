import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runReaderSetup } from './reader-setup.mjs';
import { applyReaderAccount, readerAccountId, activeReaderAccount } from './reader-account-state.mjs';
import { validateConfig } from './project-config.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
export const KEY_COMPONENT_SHA256 = '9a2f2c6a09a3219afa4748a5e7e513d99c607173c3112c5afcc888996b98248c';
const componentRelative = 'components/weflow-cli/resources/key/win32/x64/wx_key.dll';
const fault = code => Object.assign(new Error(code), { code });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const absoluteLocal = value => typeof value === 'string' && path.isAbsolute(value) && !/^[\\/]{2}/u.test(value) && !/[\0\r\n]/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function noLinks(file) {
  let current = path.resolve(file);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw fault('READER_LOCAL_LINK_REJECTED');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(file);
}

function checkedFile(file, maxBytes = Infinity) {
  noLinks(file);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > maxBytes) throw fault('READER_LOCAL_FILE_INVALID');
  return fs.realpathSync(file);
}

function readJson(file, maxBytes = 65536) {
  checkedFile(file, maxBytes);
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw fault('READER_LOCAL_JSON_INVALID'); }
}

function statePaths(root) {
  const directory = noLinks(path.resolve(root, 'state/reader'));
  return { directory, request: path.join(directory, 'connection-request.json'), credentials: path.join(directory, 'credentials.json'), lock: path.join(directory, 'connection.lock') };
}

function discoveredAccount(root, discoveryName) {
  if (typeof discoveryName !== 'string' || !/^discovery-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(discoveryName)) throw fault('READER_LOCAL_DISCOVERY_INVALID');
  const file = path.join(statePaths(root).directory, discoveryName);
  const report = readJson(file);
  if (!object(report) || report.schemaVersion !== 1 || report.readOnlyDiscovery !== true || report.databaseContentRead !== false || report.processAttached !== false ||
      !absoluteLocal(report.dataRoot) || !Array.isArray(report.accounts) || report.accounts.length !== 1) throw fault('READER_LOCAL_DISCOVERY_NOT_UNIQUE');
  const account = report.accounts[0];
  if (!object(account) || account.ready !== true || !absoluteLocal(account.dbPath) || typeof account.myWxid !== 'string' || !account.myWxid ||
      account.myWxid.length > 256 || /[\0\r\n\\/]/u.test(account.myWxid) || !samePath(path.dirname(account.dbPath), report.dataRoot) || path.basename(account.dbPath) !== account.myWxid) throw fault('READER_LOCAL_DISCOVERY_INVALID');
  noLinks(account.dbPath);
  if (!fs.statSync(account.dbPath, { throwIfNoEntry: false })?.isDirectory()) throw fault('READER_LOCAL_ACCOUNT_DIRECTORY_MISSING');
  const dbPath = fs.realpathSync(account.dbPath);
  for (const relative of ['db_storage/message/message_0.db', 'db_storage/contact/contact.db']) checkedFile(path.join(dbPath, relative));
  return { file, discoverySha256: sha256(fs.readFileSync(file)), dbPath, myWxid: account.myWxid,
    accountRef: sha256(path.resolve(dbPath).toLowerCase()) };
}

export function validateProtectedCredential(value, accountRef) {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'accountRef', 'protectedKey', 'savedAt'].includes(key)) ||
      value.schemaVersion !== 1 || value.accountRef !== accountRef || !digest(accountRef) || typeof value.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.savedAt)) || typeof value.protectedKey !== 'string' || value.protectedKey.length > 16384 ||
      !/^userdpapi:[A-Za-z0-9+/]+={0,2}$/.test(value.protectedKey)) throw fault('READER_LOCAL_PROTECTED_CREDENTIAL_REQUIRED');
  const encoded = value.protectedKey.slice('userdpapi:'.length), bytes = Buffer.from(encoded, 'base64');
  // CryptProtectData's version and provider GUID, not merely a caller-supplied prefix.
  if (bytes.length < 40 || bytes.toString('base64') !== encoded || bytes.subarray(0, 20).toString('hex') !== '01000000d08c9ddf0115d1118c7a00c04fc297eb') throw fault('READER_LOCAL_PROTECTED_CREDENTIAL_REQUIRED');
  return value;
}

function cachedCredential(root, accountRef) {
  const file = statePaths(root).credentials;
  return fs.existsSync(file) ? validateProtectedCredential(readJson(file, 20000), accountRef) : null;
}

function atomicJson(file, value, replace) {
  noLinks(file);
  if (!replace && fs.existsSync(file)) throw fault('READER_LOCAL_FILE_ALREADY_EXISTS');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    if (!replace && fs.existsSync(file)) throw fault('READER_LOCAL_FILE_ALREADY_EXISTS');
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Preparation only. No DLL loads, process discovery, credentials or production settings. */
export function prepareLocalReaderRequest({ root = projectRoot, discoveryName, wechatExecutable }) {
  const paths = statePaths(root), account = discoveredAccount(root, discoveryName);
  if (!absoluteLocal(wechatExecutable) || path.basename(wechatExecutable).toLowerCase() !== 'weixin.exe') throw fault('READER_LOCAL_EXECUTABLE_INVALID');
  const executable = checkedFile(wechatExecutable, 256 * 1024 * 1024);
  const request = { schemaVersion: 1, discoveryFile: discoveryName, discoverySha256: account.discoverySha256, accountRef: account.accountRef,
    wechatExecutable: executable, wechatExecutableSha256: sha256(fs.readFileSync(executable)), autoKey: true };
  atomicJson(paths.request, request, false);
  return { ok: true, requestPrepared: true, accountCandidateCount: 1, credentialsWritten: false, processAttached: false };
}

/** Local files and identity bindings only; even --check must never load wx_key.dll. */
export function checkLocalReader({ root = projectRoot } = {}) {
  const paths = statePaths(root), request = readJson(paths.request);
  const keys = ['schemaVersion', 'discoveryFile', 'discoverySha256', 'accountRef', 'wechatExecutable', 'wechatExecutableSha256', 'autoKey'];
  if (!object(request) || Object.keys(request).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(request, key)) || request.schemaVersion !== 1 || request.autoKey !== true ||
      !digest(request.discoverySha256) || !digest(request.accountRef) || !digest(request.wechatExecutableSha256) || !absoluteLocal(request.wechatExecutable) ||
      path.basename(request.wechatExecutable).toLowerCase() !== 'weixin.exe') throw fault('READER_LOCAL_REQUEST_INVALID');
  const account = discoveredAccount(root, request.discoveryFile);
  if (account.accountRef !== request.accountRef || account.discoverySha256 !== request.discoverySha256) throw fault('READER_LOCAL_DISCOVERY_CHANGED');
  const executable = checkedFile(request.wechatExecutable, 256 * 1024 * 1024);
  if (!samePath(executable, request.wechatExecutable) || sha256(fs.readFileSync(executable)) !== request.wechatExecutableSha256) throw fault('READER_LOCAL_EXECUTABLE_CHANGED');
  const component = checkedFile(path.join(root, componentRelative), 1024 * 1024);
  if (sha256(fs.readFileSync(component)) !== KEY_COMPONENT_SHA256) throw fault('READER_LOCAL_KEY_COMPONENT_CHANGED');
  const python = checkedFile(path.join(paths.directory, 'venv/Scripts/python.exe'), 64 * 1024 * 1024);
  const runtime = readJson(path.join(paths.directory, 'runtime-check.json'));
  if (runtime.schemaVersion !== 1 || runtime.isolated !== true || runtime.memoryDatabaseCheck !== true || !Array.isArray(runtime.pythonVersion) ||
      runtime.pythonVersion[0] !== 3 || runtime.pythonVersion[1] !== 12 || !samePath(runtime.prefix, path.join(paths.directory, 'venv')) ||
      runtime.requirementsSha256 !== sha256(fs.readFileSync(checkedFile(path.join(root, 'scripts/reader-requirements.txt'), 16384)))) throw fault('READER_LOCAL_RUNTIME_NOT_VERIFIED');
  const cache = cachedCredential(root, account.accountRef);
  return { account, python, request, cached: cache,
    summary: { ok: true, mode: 'reader-local-setup-check', requestVerified: true, accountCandidateCount: 1, componentHashVerified: true,
      runtimeReportVerified: true, liveAccountVerified: false, protectedCredentialPresent: !!cache, processAttached: false, keyComponentLoaded: false } };
}

export function saveProtectedCredential({ root = projectRoot, accountRef, protectedKey }) {
  const value = validateProtectedCredential({ schemaVersion: 1, accountRef, protectedKey, savedAt: new Date().toISOString() }, accountRef);
  // Validate the old cache before replacement; never silently overwrite another account.
  cachedCredential(root, accountRef);
  atomicJson(statePaths(root).credentials, value, true);
}

const setupCodes = new Set(['READER_PATH_MISSING','READER_DATABASE_MISSING','READER_KEY_INVALID','READER_KEY_REQUIRED','READER_SECRET_UNAVAILABLE',
  'READER_DATABASE_UNREADABLE','READER_DEPENDENCY_MISSING','READER_RUNTIME_MISSING','READER_KEY_COMPONENT_MISSING','WECHAT_NOT_RUNNING',
  'WECHAT_MULTIPLE_PROCESSES','WECHAT_PROCESS_IDENTITY_UNCLEAR','READER_KEY_ACCESS_DENIED','READER_SETUP_TIMEOUT','READER_SETUP_PROTOCOL','READER_SETUP_CLEANUP_UNCONFIRMED']);
const progressCodes = new Map([
  ['读取组件已就绪，正在等待同一微信账号的数据库初始化。', { stage: 'waiting-for-login', code: 'READER_LOCAL_COMPONENT_ATTACHED' }],
  ['正在验证当前账号的已有密钥与数据库…', { stage: 'verifying-cache', code: 'READER_LOCAL_VERIFYING_CACHE' }],
  ['数据库验证通过，正在安全保存读取凭据…', { stage: 'protecting-credential', code: 'READER_LOCAL_DATABASE_VERIFIED' }],
]);

/** check/setup injection is for offline contract tests; the CLI always uses the real implementations. */
export async function connectLocalReader({ root = projectRoot, check = checkLocalReader, setup = runReaderSetup, onProgress = () => {} } = {}) {
  const paths = statePaths(root), lockToken = crypto.randomUUID();
  let locked = false, preserveLock = false;
  try {
    noLinks(paths.lock);
    try { fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, token: lockToken }), { flag: 'wx', mode: 0o600 }); locked = true; }
    catch { throw fault('READER_LOCAL_CONNECT_BUSY'); }
    const binding = check({ root });
    if (process.env.PYTHONPATH || process.env.PYTHONHOME) throw fault('READER_LOCAL_PYTHON_ENVIRONMENT_UNSAFE');
    // The child additionally resolves a unique main process by this exact executable
    // path before InitializeHook; it fails closed on a missing or ambiguous process.
    const request = { operation: 'connect', dbPath: binding.account.dbPath, myWxid: binding.account.myWxid,
      autoKey: true, wechatExecutable: binding.request.wechatExecutable, ...(binding.cached ? { decryptKey: binding.cached.protectedKey } : {}) };
    onProgress({ stage: 'connecting', code: 'READER_LOCAL_WAITING_FOR_LOGIN' });
    let result;
    try { result = await setup({ root, python: binding.python, request, onProgress: message => {
      const progress = progressCodes.get(message); if (progress) onProgress({ ...progress });
    } }); }
    catch (error) { throw fault(setupCodes.has(error?.message) ? error.message : 'READER_LOCAL_CONNECT_FAILED'); }
    if (!object(result) || result.ok !== true) throw fault(setupCodes.has(result?.code) ? result.code : 'READER_LOCAL_CONNECT_FAILED');
    if (!samePath(result.dbPath, binding.account.dbPath) || result.myWxid !== binding.account.myWxid) throw fault('READER_LOCAL_RESULT_ACCOUNT_MISMATCH');
    const current = check({ root });
    if (current.account.accountRef !== binding.account.accountRef || current.account.discoverySha256 !== binding.account.discoverySha256 ||
        current.request.wechatExecutableSha256 !== binding.request.wechatExecutableSha256 ||
        !samePath(current.request.wechatExecutable, binding.request.wechatExecutable)) throw fault('READER_LOCAL_REQUEST_CHANGED');
    saveProtectedCredential({ root, accountRef: binding.account.accountRef, protectedKey: result.protectedKey });
    return { ok: true, mode: 'reader-local-connect', databaseVerified: true, protectedCredentialSaved: true,
      liveAccountVerified: false, productionConfigurationWritten: false };
  } catch (error) {
    if (error?.code === 'READER_SETUP_CLEANUP_UNCONFIRMED') {
      preserveLock = true;
      // Preserve even the original lock if writing recovery metadata fails.
      try {
        const current = readJson(paths.lock, 1024);
        if (current.token === lockToken) atomicJson(paths.lock, { ...current, state: 'cleanup-unconfirmed', code: error.code }, true);
      } catch {}
    }
    throw error;
  } finally {
    if (locked && !preserveLock && fs.existsSync(paths.lock)) {
      let owned = false;
      try { owned = readJson(paths.lock, 1024).token === lockToken; } catch { /* Preserve an unrecognized lock. */ }
      if (owned) fs.unlinkSync(paths.lock);
    }
  }
}

/** Activate only the same verified local Reader account. This records database
 * identity for DSH; it does not claim the currently displayed WeChat is verified. */
export function activateLocalReaderAccount({ root = projectRoot, check = checkLocalReader } = {}) {
  const binding = check({ root });
  if (!binding.cached) throw fault('READER_LOCAL_PROTECTED_CREDENTIAL_REQUIRED');
  validateProtectedCredential(binding.cached, binding.account.accountRef);
  const managedFile = noLinks(path.join(root, 'state/runtime.json'));
  if (fs.existsSync(managedFile)) {
    const managed = readJson(managedFile);
    if (['adapter','bridge','reader','weflow'].some(key => managed[key])) throw fault('READER_LOCAL_ACTIVATION_BUSY');
  }
  for (const relative of ['state/reader-service/service.lock', 'state/ui-service.lock', 'state/reader/connection.lock']) {
    const file = noLinks(path.join(root, relative));
    if (fs.existsSync(file)) throw fault('READER_LOCAL_ACTIVATION_BUSY');
  }
  const readerFile = noLinks(path.join(root, 'state/weflow/WeFlow-config.json'));
  const previous = fs.existsSync(readerFile) ? readJson(readerFile) : {};
  const priorId = readerAccountId(root, previous), activeId = activeReaderAccount(root).id;
  if ((priorId && priorId !== binding.account.accountRef) || (activeId && activeId !== binding.account.accountRef)) throw fault('READER_LOCAL_ACTIVATION_ACCOUNT_MISMATCH');
  const configFile = noLinks(path.join(root, 'config/wechatagent.json'));
  const config = readJson(fs.existsSync(configFile) ? configFile : path.join(root, 'config/wechatagent.example.json'), 1024 * 1024);
  config.runtime = { ...config.runtime, sender: 'wechat-ui', weflowMode: 'nt', python: binding.python };
  config.ui = { ...config.ui, bridgeConfig: config.ui?.bridgeConfig ?? path.join(root, 'state/ui-bridge/config.json') };
  validateConfig(config);
  const settings = { ...previous, dbPath: binding.account.dbPath, myWxid: binding.account.myWxid, decryptKey: binding.cached.protectedKey };
  if (readerAccountId(root, settings) !== binding.account.accountRef) throw fault('READER_LOCAL_ACTIVATION_ACCOUNT_MISMATCH');
  const current = check({ root });
  if (current.account.accountRef !== binding.account.accountRef || current.cached?.protectedKey !== binding.cached.protectedKey) throw fault('READER_LOCAL_REQUEST_CHANGED');
  const applied = applyReaderAccount(root, previous, settings, config, { writeConfig: true });
  return { ok: true, mode: 'reader-local-activate', readerAccountActivated: true, productionConfigurationWritten: true,
    needsDshRestart: applied.needsDshRestart, liveAccountVerified: false, automaticReplies: false, inputSent: false };
}

async function main(args) {
  if (args.length !== 1 || !['--check', '--connect', '--activate', '--connect-and-activate'].includes(args[0])) throw fault('READER_LOCAL_ARGUMENTS_INVALID');
  if (args[0] === '--activate') { console.log(JSON.stringify(activateLocalReaderAccount(), null, 2)); return; }
  let result = args[0] === '--check' ? checkLocalReader().summary : await connectLocalReader({ onProgress: ({ code }) => {
    const messages = {
      READER_LOCAL_WAITING_FOR_LOGIN: '正在连接已选微信；读取组件就绪后会显示登录提示。',
      READER_LOCAL_COMPONENT_ATTACHED: '读取组件已就绪，正在等待数据库初始化。若停留在此状态，请在当前微信手动退出账号并重新登录同一账号；程序最多等待约 3 分钟。',
      READER_LOCAL_VERIFYING_CACHE: '正在验证本机保存的受保护凭据。',
      READER_LOCAL_DATABASE_VERIFIED: '所选账号数据库验证通过，正在保存受保护凭据。',
    };
    if (messages[code]) console.error(messages[code]);
  } });
  if (args[0] === '--connect-and-activate') result = { ...result, ...activateLocalReaderAccount() };
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const code = /^READER_LOCAL_[A-Z0-9_]+$/.test(error?.code ?? '') || setupCodes.has(error?.code) ? error.code : 'READER_LOCAL_SETUP_FAILED';
    console.error(code); process.exitCode = 1;
  });
}
