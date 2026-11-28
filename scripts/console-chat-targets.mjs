import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { validChatId } from '../packages/wechat-identity.mjs';

const fault = (message, status = 409) => Object.assign(Error(message), { status });
const validHeads = heads =>
  heads &&
  typeof heads === 'object' &&
  !Array.isArray(heads) &&
  Object.keys(heads).length > 0 &&
  Object.entries(heads).every(
    ([shard, head]) =>
      /^[a-f0-9]{64}$/.test(shard) &&
      typeof head === 'string' &&
      /^(0|[1-9]\d{0,18})$/.test(head) &&
      BigInt(head) <= 0x7fffffffffffffffn,
  );

// Search reads contact metadata. Saving selected contacts also reads their shard heads.
export function localContacts(root, python, query) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-B', path.join(root, 'scripts/reader-api.py'), '--contacts'],
      {
        cwd: root,
        windowsHide: true,
        timeout: 12000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, output) => {
        try {
          if (error) throw error;
          const value = JSON.parse(output);
          if (!Array.isArray(value.contacts) || !/^[a-f0-9]{64}$/.test(value.account)) throw Error();
          resolve(value);
        } catch {
          reject(fault('无法读取本机联系人目录，请先在连接设置中验证微信账号。', 503));
        }
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(query));
  });
}

const targets = config =>
  Object.entries(config.wechat.whitelist).flatMap(([kind, ids]) =>
    ['private', 'groups'].includes(kind) ? ids.map(id => ({ kind: kind === 'groups' ? 'group' : 'private', id })) : [],
  );

// Only the target list is edited. The console supplies its shared validated,
// atomic configuration writer; unrelated settings cannot arrive in this body.
export function createChatTargetsApi({
  root,
  readConfig,
  saveConfig,
  readContacts = localContacts,
  account = () => {
    const file = path.join(root, 'state/weflow/active-account.json');
    const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
    return value.id || value.legacyId || 'legacy';
  },
}) {
  const snapshot = () => {
    const current = readConfig();
    return { ...current, account: account(), targets: targets(current.config) };
  };
  async function verifyAdditions(previous, next, expectedAccount) {
    const added = targets(next).filter(
      row => !previous.wechat.whitelist[row.kind === 'group' ? 'groups' : 'private'].includes(row.id),
    );
    if (!added.length) return {};
    const result = await readContacts(root, previous.runtime?.python, { ids: added.map(row => row.id) });
    const verified = new Map(result.contacts.map(row => [row.username, row]));
    if (result.account !== expectedAccount || account() !== expectedAccount || added.some(row => !verified.has(row.id)))
      throw fault('联系人目录已变化，请重新搜索并选择可用的聊天。');
    if (added.some(row => row.kind === 'group' && verified.get(row.id).canSend !== true))
      throw fault('微信无法唯一定位新选的群聊。请修改群名，再重新搜索。');
    if (
      !Number.isSafeInteger(result.since) ||
      result.since <= 0 ||
      added.some(row => !validHeads(verified.get(row.id).heads))
    )
      throw fault('无法建立聊天收件边界，请核对读取连接后重试。', 503);
    return Object.fromEntries(
      added.map(({ kind, id }) => [
        `wechat:${kind}:${id}`,
        { account: expectedAccount, since: result.since, heads: verified.get(id).heads },
      ]),
    );
  }
  async function replace(body) {
    const current = snapshot();
    if (
      !body ||
      Object.keys(body).some(key => !['revision', 'account', 'targets'].includes(key)) ||
      !Array.isArray(body.targets) ||
      body.targets.length > 1000 ||
      body.targets.some(
        row =>
          !row || Object.keys(row).some(name => name !== 'kind' && name !== 'id') || !validChatId(row.kind, row.id),
      )
    )
      throw fault('请选择有效的好友或群聊。', 400);
    if (body.revision !== current.revision) throw fault('聊天名单或设置已变化，请重新打开选择窗口。');
    if (body.account !== current.account) throw fault('微信账号已变化，请重新选择自动回复对象。');
    const config = structuredClone(current.config);
    config.wechat.whitelist = { private: [], groups: [] };
    for (const row of body.targets) {
      const list = config.wechat.whitelist[row.kind === 'group' ? 'groups' : 'private'];
      if (list.includes(row.id)) throw fault('回复对象重复。', 400);
      list.push(row.id);
    }
    // No asynchronous work occurs between the account check and writer call.
    if (account() !== current.account) throw fault('微信账号已变化，请重新选择自动回复对象。');
    await saveConfig({ config, revision: current.revision }, current.account);
    return snapshot();
  }
  return { snapshot, replace, verifyAdditions };
}
