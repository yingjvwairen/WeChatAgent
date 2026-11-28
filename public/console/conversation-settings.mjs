const adminOnly = (config, key) =>
  !key.startsWith('wechat:group:') || config.wechat.assistant?.adminOnlyGroups?.[key] !== false;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (object, key) => Object.hasOwn(object ?? {}, key);

export const activeChatWorkMode = (config, key) => config.wechat.workModes?.[key] ?? 'social';
export const proactiveChatField = mode => (mode === 'assistant' ? 'assistantChats' : 'chats');

// Keep concurrent updates to untouched fields. Lists are a single setting so
// competing grants and revocations never get merged into a wider permission.
export function rebaseConfigDraft(previous, draft, current) {
  const conflicts = [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const merge = (before, pending, saved, path) => {
    if (same(before, pending)) return structuredClone(saved);
    if (same(before, saved) || same(pending, saved)) return structuredClone(pending);
    if ((before === undefined || object(before)) && object(pending) && object(saved)) {
      const keys = new Set([...Object.keys(saved), ...Object.keys(pending), ...Object.keys(before ?? {})]);
      return Object.fromEntries(
        [...keys]
          .map(key => [
            key,
            merge(
              own(before, key) ? before[key] : undefined,
              own(pending, key) ? pending[key] : undefined,
              own(saved, key) ? saved[key] : undefined,
              [...path, key],
            ),
          ])
          .filter(([, value]) => value !== undefined),
      );
    }
    conflicts.push(path.join('.'));
    return structuredClone(saved);
  };
  return { config: merge(previous, draft, current, []), conflicts };
}

export function chatSettingsSnapshot(config, key, mode = activeChatWorkMode(config, key)) {
  const active = activeChatWorkMode(config, key);
  if (mode !== active) {
    const stored = structuredClone(config.wechat.modeSettings?.[key]?.[mode]);
    if (stored) delete stored.settings.fileTransfer;
    return stored
      ? {
          ...stored,
          settings: {
            ...stored.settings,
            adminOnly: adminOnly(config, key),
            ...(mode === 'assistant' ? { proactive: config.wechat.proactive?.assistantChats?.[key] === true } : {}),
          },
        }
      : {
          settings: {
            adminOnly: adminOnly(config, key),
            workMode: mode,
            persona: null,
            mode: null,
            stickers: null,
            search: null,
            proactive: config.wechat.proactive?.[proactiveChatField(mode)]?.[key] === true,
            context: null,
          },
          access: { skills: [], tools: [] },
        };
  }
  const w = config.wechat;
  return {
    settings: {
      persona: config.persona.chats?.[key] ?? null,
      workMode: active,
      adminOnly: adminOnly(config, key),
      mode: w.chatModes?.[key] ?? null,
      stickers: w.stickers?.chats?.[key] ?? null,
      search: w.search?.chats?.[key] ?? null,
      proactive: w.proactive?.[proactiveChatField(active)]?.[key] === true,
      context: w.context?.chats?.[key] ?? null,
    },
    access: {
      ...w.dshAccess?.chats?.[key],
      ...Object.fromEntries(
        ['skills', 'tools'].map(kind => [kind, [...(w.dshAccess?.chats?.[key]?.[kind] ?? [])].sort()]),
      ),
    },
  };
}

export function applyChatSettings(config, key, settings, access) {
  const fail = message => {
    throw Object.assign(new Error(message), { status: 400 });
  };
  if (
    !settings ||
    Array.isArray(settings) ||
    ![6, 7, 8, 9].includes(Object.keys(settings).length) ||
    Object.keys(settings).some(
      name =>
        ![
          'persona',
          'workMode',
          'adminOnly',
          'fileTransfer',
          'mode',
          'stickers',
          'search',
          'proactive',
          'context',
        ].includes(name),
    ) ||
    !['persona', 'mode', 'stickers', 'search', 'proactive', 'context'].every(name => own(settings, name))
  )
    fail('会话设置不完整，请重新打开。');
  if (
    own(settings, 'adminOnly') &&
    (typeof settings.adminOnly !== 'boolean' || (!key.startsWith('wechat:group:') && !settings.adminOnly))
  )
    fail('私聊助手仅允许管理员，群管理员模式必须使用开关值。');
  if (settings.persona !== null && (typeof settings.persona !== 'string' || !settings.persona))
    fail('请选择有效人格。');
  if (own(settings, 'workMode') && !['social', 'assistant'].includes(settings.workMode))
    fail('请选择聊天模式或助手模式。');
  if (settings.mode !== null && (!key.startsWith('wechat:group:') || !['hybrid', 'mention'].includes(settings.mode)))
    fail('请选择有效的群聊回复方式。');
  if (
    ['stickers', 'search'].some(name => settings[name] !== null && typeof settings[name] !== 'boolean') ||
    typeof settings.proactive !== 'boolean'
  )
    fail('功能设置必须使用开关值。');
  if (
    settings.context !== null &&
    (!Number.isSafeInteger(settings.context) ||
      (settings.context !== 0 && (settings.context < 4000 || settings.context > 2000000)))
  )
    fail('上下文阈值为 4,000–2,000,000 token；填 0 关闭，留空继承默认。');
  if (
    !access ||
    !Array.isArray(access.skills) ||
    !Array.isArray(access.tools) ||
    Object.keys(access).some(
      name => !['skills', 'tools', 'mode', 'preset', 'remoteApproval', 'timeoutMinutes', 'toolLimit'].includes(name),
    )
  )
    fail('技能与工具列表无效，请重新打开。');
  if (access.preset !== undefined && (typeof access.preset !== 'string' || !/^[\w.:-]{1,120}$/.test(access.preset)))
    fail('DSH 预设无效。');
  if (
    (access.mode !== undefined && !['custom', 'native'].includes(access.mode)) ||
    (access.remoteApproval !== undefined && typeof access.remoteApproval !== 'boolean') ||
    (access.timeoutMinutes !== undefined &&
      (!Number.isInteger(access.timeoutMinutes) || access.timeoutMinutes < 5 || access.timeoutMinutes > 120)) ||
    (access.toolLimit !== undefined &&
      (!Number.isInteger(access.toolLimit) || access.toolLimit < 10 || access.toolLimit > 1000))
  )
    fail('助手能力设置无效。');
  if (
    settings.workMode !== 'assistant' &&
    (access.mode === 'native' || access.remoteApproval === true || access.preset !== undefined)
  )
    fail('DSH 完整能力及微信审批仅适用于助手模式。');
  if (own(settings, 'adminOnly') && key.startsWith('wechat:group:')) {
    config.wechat.assistant ??= {};
    config.wechat.assistant.adminOnlyGroups ??= {};
    config.wechat.assistant.adminOnlyGroups[key] = settings.adminOnly;
  }
  const previous = chatSettingsSnapshot(config, key);
  const saveModes =
    (own(settings, 'workMode') && settings.workMode !== previous.settings.workMode) ||
    !!config.wechat.modeSettings?.[key];
  if (saveModes) {
    config.wechat.modeSettings ??= {};
    config.wechat.modeSettings[key] ??= {};
    config.wechat.modeSettings[key][previous.settings.workMode] = previous;
  }
  const put = (map, value) => {
    if (value === null) delete map[key];
    else map[key] = value;
  };
  config.persona.chats ??= {};
  put(config.persona.chats, settings.persona);
  if (own(settings, 'workMode') && (settings.workMode !== 'social' || config.wechat.workModes)) {
    config.wechat.workModes ??= {};
    config.wechat.workModes[key] = settings.workMode;
  }
  config.wechat.chatModes ??= {};
  put(config.wechat.chatModes, settings.mode);
  for (const name of ['stickers', 'search', 'context']) {
    config.wechat[name] ??= {};
    config.wechat[name].chats ??= {};
    put(config.wechat[name].chats, settings[name]);
  }
  const field = proactiveChatField(activeChatWorkMode(config, key));
  if (field === 'chats' || settings.proactive || own(config.wechat.proactive?.[field], key)) {
    config.wechat.proactive ??= {};
    config.wechat.proactive[field] ??= {};
    put(config.wechat.proactive[field], settings.proactive);
  }
  config.wechat.dshAccess ??= { chats: {} };
  config.wechat.dshAccess.chats ??= {};
  config.wechat.dshAccess.chats[key] = structuredClone(access);
  if (saveModes) config.wechat.modeSettings[key][activeChatWorkMode(config, key)] = chatSettingsSnapshot(config, key);
  return config;
}

// Rebase pending edits onto the server result, then accept only this chat's saved fields.
export function mergeConversationSave(previous, draft, saved, key) {
  const merge = (before, pending, current) => {
    if (same(before, pending)) return structuredClone(current);
    if (!pending || typeof pending !== 'object' || Array.isArray(pending) || !before || typeof before !== 'object')
      return structuredClone(pending);
    const result = structuredClone(current ?? {});
    for (const name of new Set([...Object.keys(before), ...Object.keys(pending)])) {
      if (!own(pending, name)) delete result[name];
      else result[name] = merge(before[name], pending[name], current?.[name]);
    }
    return result;
  };
  const result = merge(previous, draft, saved);
  const accept = (target, source) => {
    if (own(source, key)) target[key] = structuredClone(source[key]);
    else delete target[key];
  };
  result.persona.chats ??= {};
  accept(result.persona.chats, saved.persona.chats);
  for (const name of ['modeSettings', 'workModes', 'chatModes', 'stickers', 'search', 'proactive', 'context']) {
    if (name === 'chatModes' || name === 'workModes' || name === 'modeSettings') {
      if (result.wechat[name] || saved.wechat[name]) {
        result.wechat[name] ??= {};
        accept(result.wechat[name], saved.wechat[name]);
      }
    } else if (result.wechat[name]?.chats || saved.wechat[name]?.chats) {
      result.wechat[name] ??= {};
      result.wechat[name].chats ??= {};
      accept(result.wechat[name].chats, saved.wechat[name]?.chats);
    }
  }
  if (saved.wechat.proactive?.assistantChats || result.wechat.proactive?.assistantChats) {
    result.wechat.proactive.assistantChats ??= {};
    accept(result.wechat.proactive.assistantChats, saved.wechat.proactive?.assistantChats);
  }
  if (saved.wechat.assistant?.adminOnlyGroups || result.wechat.assistant?.adminOnlyGroups) {
    result.wechat.assistant ??= {};
    result.wechat.assistant.adminOnlyGroups ??= {};
    accept(result.wechat.assistant.adminOnlyGroups, saved.wechat.assistant?.adminOnlyGroups);
  }
  result.wechat.dshAccess ??= { chats: {} };
  result.wechat.dshAccess.chats ??= {};
  accept(result.wechat.dshAccess.chats, saved.wechat.dshAccess?.chats);
  return result;
}
