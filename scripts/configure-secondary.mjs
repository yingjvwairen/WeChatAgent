import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { projectRoot, validateConfig } from './project-config.mjs';
import { inspectWeChatClient } from './wechat-client-selection.mjs';
import { validateProfiles } from './local-model-profiles.mjs';
import { managedSpeechCommand } from './local-speech-owned.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const fields = (value, names) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !names.includes(key))
  )
    throw Error('副机设置包含无效字段。');
};
function localFile(value, directory = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value))
    throw Error('请填写本机绝对路径。');
  const file = fs.realpathSync(value);
  const stat = fs.statSync(file);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('副机路径类型错误。');
  return file;
}

// A concurrent import either sees the complete, identical file or reports a conflict.
function publish(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', flush: true, mode: 0o600 });
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (fs.readFileSync(file, 'utf8') !== contents) throw Error('已有不同的本机设置，请在控制台修改。');
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function configureSecondary(root, settings, inspectClient = inspectWeChatClient) {
  fields(settings, ['runtime', 'input']);
  fields(settings.runtime, ['python', 'dshDesktop', 'localSpeech']);
  fields(settings.input, [
    'wechatExecutable',
    'controlMode',
    'offscreen',
    'typeText',
    'voiceSend',
    'sendKey',
    'idleMs',
  ]);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/wechatagent.example.json'), 'utf8'));
  const runtime = settings.runtime;
  config.runtime.python = localFile(runtime.python);
  config.runtime.dshDesktop = localFile(runtime.dshDesktop);
  if (
    !/^python(?:3(?:\.\d+)?)?\.exe$/i.test(path.basename(config.runtime.python)) ||
    path.extname(config.runtime.dshDesktop).toLowerCase() !== '.exe'
  )
    throw Error('请选择有效的 Python 和 DSH 程序。');
  const client = await inspectClient({ root, executable: localFile(settings.input.wechatExecutable) });
  Object.assign(config.input, settings.input, { wechatExecutable: client.path, expectedVersion: client.version });

  const profiles = [];
  const services = runtime.localSpeech ?? {};
  fields(services, ['asr', 'tts']);
  for (const [kind, raw] of Object.entries(services)) {
    fields(raw, ['enabled', 'python', 'modelDirectory', 'profiles', 'preload', 'port']);
    const service = {
      ...raw,
      enabled: raw.enabled ?? true,
      python: localFile(raw.python),
      modelDirectory: localFile(raw.modelDirectory, true),
    };
    if (raw.profiles) {
      const rows = validateProfiles(root, kind, { ...service, profiles: '' }, raw.profiles);
      if (service.preload && !Object.hasOwn(rows, service.preload)) throw Error('预加载方案不存在。');
      const contents = json(rows);
      const digest = createHash('sha256').update(contents).digest('hex');
      service.profiles = path.join('state', 'local-speech', kind + '-' + digest + '.json');
      profiles.push([path.join(root, service.profiles), contents]);
    } else if (kind === 'tts') throw Error('请填写本地合成方案。');
    else validateProfiles(root, 'asr', service, { default: { modelDirectory: service.modelDirectory } });
    managedSpeechCommand(root, kind, service);
    (config.runtime.localSpeech ??= {})[kind] = service;
  }
  validateConfig(config);
  const file = path.join(root, 'config/wechatagent.json'),
    contents = json(config);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== contents)
    throw Error('已有不同的本机设置，请在控制台修改。');
  for (const [target, data] of profiles) publish(target, data);
  publish(file, contents);
  return { file, profiles: profiles.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--settings')
    throw Error('用法：npm run secondary:configure -- --settings <JSON 文件>');
  const file = localFile(path.resolve(args[1]));
  if (fs.statSync(file).size > 131072) throw Error('副机设置文件过大。');
  console.log(
    JSON.stringify(
      await configureSecondary(projectRoot, JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))),
    ),
  );
}
