import { validChatId } from '../packages/wechat-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLUGIN_HOST_FILES } from '../packages/plugin-api/contract.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectRoleText } from '../components/qq-bridge/src/role-card.js';
import { personaError } from '../public/console/persona-files.mjs';
import { upsertToolCatalogPatch } from '../packages/dsh-social-bridge-plugin/plugin-catalog.mjs';
import { upsertAssistantPresetPatch } from '../packages/dsh-social-bridge-plugin/assistant-preset.mjs';
import { validateStickerSettings } from '../components/qq-bridge/src/core/sticker-policy.js';
import { validateSearchSettings } from '../packages/dsh-social-bridge-plugin/search-policy.mjs';
import { validateProactiveSettings } from '../components/qq-bridge/src/core/proactive-policy.js';
import { validateContextSettings } from '../packages/dsh-social-bridge-plugin/context-policy.mjs';
import {
  validateHistorySettings,
  migrateHistorySettings,
} from '../packages/dsh-social-bridge-plugin/history-policy.mjs';
import { validateWebReaderSettings } from '../packages/dsh-social-bridge-plugin/web-reader-policy.mjs';
import { validateMemeLibrarySettings } from '../packages/dsh-social-bridge-plugin/meme-library-policy.mjs';
import { validateFishNotebook } from '../packages/dsh-social-bridge-plugin/fish-notebook-policy.mjs';
import { validateMemberMemory } from '../packages/dsh-social-bridge-plugin/member-memory-policy.mjs';

import {
  validateConversationSettings,
  conversationMode,
} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import { migrateDshSettings } from '../packages/dsh-social-bridge-plugin/dsh-migration.mjs';
import { DESKTOP_BACKEND, desktopSettings } from './desktop-settings.mjs';
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
};

function pluginRevision(root, moduleDir) {
  const sources = fs
    .readdirSync(moduleDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:[cm]?js|json)$/u.test(entry.name))
    .map(entry => path.join(moduleDir, entry.name));
  const skillsDir = path.join(moduleDir, 'skills');
  if (fs.existsSync(skillsDir))
    for (const entry of fs.readdirSync(skillsDir, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) sources.push(path.join(entry.parentPath, entry.name));
  for (const name of ['index.mjs', 'catalog.mjs', 'snapshots.mjs']) {
    const file = path.join(root, 'packages/extension-runtime', name);
    if (fs.existsSync(file)) sources.push(file);
  }
  if (fs.existsSync(path.join(root, 'packages/plugin-api'))) {
    for (const name of [...PLUGIN_HOST_FILES, 'scripts/reader-account-state.mjs']) {
      const file = path.join(root, name);
      if (!fs.existsSync(file)) throw Error('插件宿主文件不完整，请更新 WeChatAgent：' + name);
      sources.push(file);
    }
  }
  const revision = crypto.createHash('sha256');
  for (const file of sources.sort()) {
    const content = fs.readFileSync(file);
    const name = path.relative(root, file).replaceAll(path.sep, '/');
    revision.update(JSON.stringify([name, content.length])).update(content);
  }
  return revision.digest('hex').slice(0, 16);
}

export function validateConfig(config) {
  validateFishNotebook(config.wechat?.fishNotebook);
  validateHistorySettings(config.wechat?.history);
  validateMemberMemory(config.wechat?.memberMemory);
  validateMemeLibrarySettings(config.wechat?.memeLibrary);
  validateConversationSettings(config.wechat);
  validateStickerSettings(config.wechat?.stickers);
  validateSearchSettings(config.wechat?.search);
  validateProactiveSettings(config.wechat?.proactive);
  validateContextSettings(config.wechat?.context);
  validateWebReaderSettings(config.wechat?.webReader);
  if (config.runtime?.localSpeech !== undefined) {
    const services = config.runtime.localSpeech;
    if (!services || typeof services !== 'object' || Array.isArray(services)) throw Error('本机语音服务配置无效。');
    for (const kind of ['asr', 'tts']) {
      const service = services[kind];
      if (service === undefined) continue;
      if (
        !service ||
        typeof service !== 'object' ||
        Array.isArray(service) ||
        (service.enabled !== undefined && typeof service.enabled !== 'boolean')
      )
        throw Error('本机语音服务设置无效。');
      if (
        service.enabled &&
        (!service.python || !(kind === 'asr' ? service.modelDirectory || service.profiles : service.modelDirectory))
      ) {
        throw Error('请先选择本机语音解释器、模型位置及所需的方案文件。');
      }
    }
  }
  if (config.version !== 2) throw new Error('请使用新版配置并重新选择微信聊天。');
  if (!['nt', 'bundled', 'existing'].includes(config.runtime?.weflowMode ?? 'nt'))
    throw new Error('weflowMode must be nt, bundled or existing');
  if (config.runtime?.sender !== DESKTOP_BACKEND) throw new Error('sender must be wechat-ui');
  if ((config.runtime.weflowMode ?? 'nt') !== 'nt') throw new Error('Desktop sending requires the NT reader');
  desktopSettings(config, projectRoot, { requireClient: false });
  const ports = Object.values(config.ports ?? {});
  if (ports.length !== 4 || ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || new Set(ports).size !== 4)
    throw new Error('Configure four distinct service ports between 1024 and 65535');
  if (!['weflow', 'onebot', 'adapter', 'dshPlugin'].every(key => Number.isInteger(config.ports[key])))
    throw new Error('Required ports: weflow, onebot, adapter, dshPlugin');
  if (!config.runtime?.python || !Array.isArray(config.account?.nicknames) || !config.account.nicknames.length)
    throw new Error('Python and account nicknames are required');
  for (const kind of ['groups', 'private']) {
    if (
      !Array.isArray(config.wechat?.whitelist?.[kind]) ||
      config.wechat.whitelist[kind].some(id => !validChatId(kind === 'groups' ? 'group' : 'private', id))
    )
      throw new Error(`Invalid ${kind} WeChat IDs; select contacts from the account directory`);
  }
  const role = value => typeof value === 'string' && /^[^\\/\0.][^\\/\0]{0,60}$/.test(value) && !value.includes('..');
  if (!role(config.persona?.default) || Object.values(config.persona?.chats ?? {}).some(value => !role(value)))
    throw new Error('Invalid persona name');
  if (!['hybrid', 'mention'].includes(config.wechat.wake_mode)) throw new Error('wake_mode must be hybrid or mention');
  if (!config.dsh?.provider || !config.dsh?.model || /[\r\n]/.test(config.dsh.provider + config.dsh.model))
    throw new Error('Configure DSH provider and model IDs');
  return config;
}
export function prepare(root = projectRoot) {
  const configFile = path.join(root, 'config', 'wechatagent.json');
  if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(root, 'config', 'wechatagent.example.json'), configFile);
  const config = validateConfig(read(configFile));
  if (migrateHistorySettings(config)) {
    validateConfig(config);
    write(configFile, config);
  }
  const migratedMeme = migrateDshSettings(root, config);
  if (migratedMeme !== null) {
    validateConfig(config);
    write(configFile, config);
  }
  const state = path.join(root, 'state');
  for (const dir of ['logs', 'weflow', 'attachments']) fs.mkdirSync(path.join(state, dir), { recursive: true });
  const desktopState = path.join(state, 'desktop');
  fs.mkdirSync(desktopState, { recursive: true });
  const controlToken = path.join(desktopState, 'control.token');
  if (!fs.existsSync(controlToken))
    fs.writeFileSync(controlToken, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const tokenFile = path.join(state, 'social-dsh-token.txt');
  if (!fs.existsSync(tokenFile))
    fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const roleTexts = new Map();
  for (const name of new Set([config.persona.default, ...Object.values(config.persona.chats ?? {})])) {
    const file = path.join(root, 'roles', `${name}.md`);
    if (!fs.existsSync(file)) throw new Error(`Persona file missing: ${name}.md`);
    const raw = fs.readFileSync(file, 'utf8'),
      rawError = personaError(name, raw);
    if (rawError) throw new Error(`人格“${name}”：${rawError}`);
    const selected = selectRoleText(raw, 'v2'),
      selectedError = personaError(name, selected);
    if (selectedError) throw new Error(`人格“${name}”在当前模式下无有效内容，请检查人格卡的模式标记。${selectedError}`);
    roleTexts.set(name, selected);
  }
  const ioFile = path.join(state, 'wechat-io-config.json');
  const previousIo = fs.existsSync(ioFile) ? read(ioFile) : {};
  write(ioFile, {
    reader_base_url: `http://127.0.0.1:${config.ports.weflow}`,
    reader_token: previousIo.reader_token || crypto.randomBytes(32).toString('hex'),
    self_wxid: previousIo.self_wxid || '',
    onebot_ws_url: `ws://127.0.0.1:${config.ports.onebot}/ws`,
  });
  const roleText = name => roleTexts.get(name);
  write(path.join(state, 'bridge-config.json'), {
    project_root: root,
    platforms: {
      wechat: {
        enabled: true,
        adapter: 'wechat-onebot',
        onebot: { server: { host: '127.0.0.1', port: config.ports.onebot, path: '/ws', timeoutMs: 45000 } },
        ...config.wechat,
      },
    },
    dsh_plugin: { url: `http://127.0.0.1:${config.ports.dshPlugin}`, timeoutMs: 190000 },
    sticker_policy_file: configFile,
    search_policy_file: configFile,
    search_state_file: path.join(state, 'search/state.json'),
    proactive_policy_file: configFile,
    proactive_state_file: path.join(state, 'proactive/state.json'),
    context_policy_file: configFile,
    message_buffer: { path: path.join(state, 'social-messages.json'), max_messages_per_chat: 300 },
    // Original Bridge accepts inline persona text; it needs no source/path changes.
    persona_name: config.persona.default,
    role: roleText(config.persona.default),
    roles: Object.fromEntries(
      Object.entries(config.persona.chats ?? {}).map(([key, name]) => [key, { name, persona: roleText(name) }]),
    ),
    social: config.social,
  });
  // Bundle config is read again when DSH fully restarts. Secrets stay in state.
  const patchFile = path.join(root, 'packages', 'dsh-social-bridge-plugin', 'cordis.patch.yml');
  if (fs.existsSync(patchFile)) {
    const existingPatch = fs.readFileSync(patchFile, 'utf8');
    const before = upsertAssistantPresetPatch(upsertToolCatalogPatch(existingPatch, root), root);
    let after = before
      .replace(/^(        provider:).*/m, `$1 ${JSON.stringify(config.dsh.provider)}`)
      .replace(/^(        model:).*/m, `$1 ${JSON.stringify(config.dsh.model)}`);
    const moduleDir = path.dirname(patchFile);
    if (fs.existsSync(path.join(moduleDir, 'native-context.mjs'))) {
      const revision = pluginRevision(root, moduleDir);
      // Revision inputs may grow or move; the Cordis plugin entry stays fixed.
      const entry = pathToFileURL(path.join(moduleDir, 'native-context.mjs')).href + '?wechatagent=' + revision;
      after = after.replace(/(    - id: dsh-social-bridge-plugin\r?\n      name:).*/, '$1 ' + JSON.stringify(entry));
      const restrictEntry =
        pathToFileURL(path.join(moduleDir, 'social-tool-restrict.mjs')).href + '?wechatagent=' + revision;
      after = after.replace(
        /(          - id: social-tool-restrict\r?\n            name:).*/,
        '$1 ' + JSON.stringify(restrictEntry),
      );
    }
    after = /^        port:/m.test(after)
      ? after.replace(/^        port:.*/m, `        port: ${config.ports.dshPlugin}`)
      : after.replace(/^(        model:.*)$/m, `$1\n        port: ${config.ports.dshPlugin}`);
    if (migratedMeme && Object.keys(migratedMeme).length && !/^        memeSearch:/m.test(after))
      after = after.replace(/^(        port:.*)$/m, '$1\n        memeSearch: ' + JSON.stringify(migratedMeme));
    if (existingPatch !== after) fs.writeFileSync(patchFile, after);
  }
  // Original WeFlow owns its encrypted configuration in every provider mode.
  return config;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare();
  console.log('WeChatAgent configuration prepared; secrets were not printed.');
}
