import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boundedTask } from './deadline.mjs';

const maximum = 6 * 1024 * 1024;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fault = (prefix, code = 'READER_NOT_READY') => new Error(prefix + '_' + code);
function noLinks(file, prefix) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault(prefix, 'READER_LINK_REJECTED');
    if (path.dirname(current) === current) return current;
  }
}
function read(file, prefix, { raw = false, max = 1024 * 1024 } = {}) {
  noLinks(file, prefix); const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size < 1 || stat.size > max) throw fault(prefix);
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (raw) return text.trim();
  try { return JSON.parse(text); } catch { throw fault(prefix); }
}
function uiScope(root, key, prefix) {
  const active = read(path.join(root, 'state/weflow/active-account.json'), prefix, { max: 8192 });
  const selection = read(path.join(root, 'state/reader-service/selection.json'), prefix, { max: 131072 });
  if (!hex(active.id) || selection.schemaVersion !== 1 || selection.accountRef !== active.id || !Number.isSafeInteger(selection.version) || selection.version < 1 ||
      !Array.isArray(selection.targets) || selection.targets.length > 32 || !/^wechat:(private|group):[1-9]\d{0,9}$/.test(key)) throw fault(prefix, 'READER_SCOPE_REVOKED');
  const matches = selection.targets.filter(item => typeof item?.wxid === 'string' && key === 'wechat:' + (item.wxid.endsWith('@chatroom') ? 'group' : 'private') + ':' + item.id);
  if (matches.length !== 1) throw fault(prefix, 'READER_SCOPE_REVOKED');
  const target = matches[0];
  if (typeof target.wxid !== 'string' || !target.wxid.length || target.wxid.length > 256 || target.wxid === 'filehelper' || !hex(target.grantId) ||
      target.id !== String(crypto.createHash('sha256').update(target.wxid).digest().readBigUInt64BE(0) % 2147483647n + 1n)) throw fault(prefix, 'READER_SCOPE_REVOKED');
  return { accountRef: active.id, selectionVersion: selection.version, grantId: target.grantId };
}
function access(root, kind, id, key, prefix, sender) {
  const project = read(path.join(root, 'config/wechatagent.json'), prefix);
  if(project?.runtime?.sender!=='wechat-ui')throw fault(prefix);
  const port = project.ports?.adapter;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fault(prefix);
  const scope = uiScope(root, key, prefix), token = read(path.join(root, 'state/social-dsh-token.txt'), prefix, { raw: true, max: 256 });
  if (!hex(token)) throw fault(prefix);
  const query=new URLSearchParams({conversationKey:key});
  if(kind==='files')query.set('senderWxid',sender);
  return { url: `http://127.0.0.1:${port}/${kind}/${id}?${query}`, token, scope,
    headers: { 'X-WeChatAgent-Account': scope.accountRef, 'X-WeChatAgent-Selection-Version': String(scope.selectionVersion), 'X-WeChatAgent-Target-Grant': scope.grantId } };
}
async function content(response, prefix) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { await response.body?.cancel().catch(() => {}); throw fault(prefix, 'READER_RESPONSE_LIMIT'); }
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > maximum) throw fault(prefix, 'READER_RESPONSE_LIMIT'); chunks.push(Buffer.from(value)); }
      try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); } catch { throw fault(prefix); }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  const body = await response.json();
  if (Buffer.byteLength(JSON.stringify(body)) > maximum) throw fault(prefix, 'READER_RESPONSE_LIMIT');
  return body;
}

/** Private media access only. Returns Reader JSON, never credentials, discovery
 * metadata or DSH settings. Each response must match the current selection. */
export async function fetchBoundReaderMedia(root, kind, id, conversationKey, options) {
  if(!['images','media'].includes(kind))throw fault('MEDIA','REFERENCE_INVALID');
  return boundRequest(root,kind,id,conversationKey,options);
}
export function fetchBoundReaderFile(root,id,conversationKey,sender,options={}){
  if(typeof sender!=='string'||!sender||sender.length>256||/[\u0000-\u001f\u007f]/.test(sender))throw fault('FILE','REFERENCE_INVALID');
  return boundRequest(root,'files',id,conversationKey,{...options,sender});
}
async function boundRequest(root, kind, id, conversationKey, { signal, sender, fetchImpl=fetch } = {}) {
  const prefix = kind === 'images' ? 'IMAGE' : kind==='files'?'FILE':'MEDIA';
  if (!hex(id) || typeof conversationKey !== 'string' || !/^wechat:(?:private|group):[1-9]\d{0,19}$/.test(conversationKey) || typeof root !== 'string' || !path.isAbsolute(root)) throw fault(prefix, 'REFERENCE_INVALID');
  return boundedTask(async taskSignal => {
    let selected;
    try { selected = access(root, kind, id, conversationKey, prefix,sender); } catch (error) { throw /^(?:IMAGE|MEDIA|FILE)_/.test(error.message) ? error : fault(prefix); }
    const response = await fetchImpl(selected.url, { headers: { Authorization: 'Bearer ' + selected.token, ...selected.headers }, redirect: 'error', signal: taskSignal });
    const result = await content(response, prefix); taskSignal.throwIfAborted();
    if (!response.ok) {
      const error = fault(prefix);
      if (typeof result?.error === 'string' && new RegExp(`^${prefix}_[A-Z0-9_]{3,80}$`).test(result.error)) { if (kind === 'images') error.imageError = result.error; else error.mediaError = result.error; }
      throw error;
    }
    const assertCurrent=()=>{
      const latest = access(root, kind, id, conversationKey, prefix,sender);
      if(latest.url!==selected.url||latest.token!==selected.token||JSON.stringify(latest.scope)!==JSON.stringify(selected.scope))throw fault(prefix,'READER_SCOPE_REVOKED');
    };
    assertCurrent();
    if (response.headers?.get?.('x-wechatagent-account') !== selected.scope.accountRef || response.headers?.get?.('x-wechatagent-selection-version') !== String(selected.scope.selectionVersion) ||
        response.headers?.get?.('x-wechatagent-target-grant') !== selected.scope.grantId) throw fault(prefix, 'READER_SCOPE_REVOKED');
    if (result?.[kind === 'images' ? 'imageId' : kind==='files'?'id':'mediaId'] !== id || result.conversationKey !== conversationKey ||
        kind==='files'&&result.senderWxid!==sender) throw fault(prefix, 'CONVERSATION_MISMATCH');
    return kind==='files'?{file:result,assertCurrent}:result;
  }, { timeoutMs: kind === 'images' ? 12000 : 120000, signal, code: prefix + '_READER_TIMEOUT' });
}
