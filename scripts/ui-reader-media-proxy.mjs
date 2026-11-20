import crypto from 'node:crypto';
import { boundedTask } from '../packages/dsh-social-bridge-plugin/deadline.mjs';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const maximum = 6 * 1024 * 1024;
function loopback(value) {
  let url; try { url = new URL(value); } catch { throw fault('UI_MEDIA_ENDPOINT_INVALID'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) throw fault('UI_MEDIA_ENDPOINT_INVALID');
  return url.origin;
}
function authorized(actual, token) {
  const expected = Buffer.from('Bearer ' + token), supplied = Buffer.from(typeof actual === 'string' ? actual : '');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
async function responseJson(response) {
  const declared = response.headers?.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { await response.body?.cancel().catch(() => {}); throw fault('UI_MEDIA_RESPONSE_LIMIT'); }
  const chunks = []; let length = 0;
  if (!response.body?.getReader) throw fault('UI_MEDIA_RESPONSE_INVALID');
  const reader = response.body.getReader();
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > maximum) throw fault('UI_MEDIA_RESPONSE_LIMIT'); chunks.push(Buffer.from(value)); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); } catch { throw fault('UI_MEDIA_RESPONSE_INVALID'); }
}
function publicContent(kind, content, id, key, sender) {
  if (!object(content) || content[kind === 'images' ? 'imageId' : kind==='files'?'id':'mediaId'] !== id || content.conversationKey !== key ||
      kind==='files'&&content.senderWxid!==sender) throw fault('UI_MEDIA_CONVERSATION_MISMATCH');
  if(kind==='files'){
    if(!['ready','not_downloaded','ambiguous','integrity_failed'].includes(content.status))throw fault('UI_MEDIA_RESPONSE_INVALID');
    const fields=['status','id','conversationKey','senderWxid','name'];
    if(content.status==='ready')fields.push('size','md5','sha256','accountRoot','path');
    else fields.push('message');
    return Object.fromEntries(fields.filter(key=>Object.hasOwn(content,key)).map(key=>[key,content[key]]));
  }
  const fields = kind === 'images' ? ['imageId','conversationKey','b64','mime','sha256','width','height','sourceQuality'] :
    ['version','mediaId','conversationKey','kind','sourceSha256','durationMs','audioPresent','frames','transcript','semanticAnalysis'];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(content, key)).map(key => [key, content[key]]));
}

/** Holds the live Reader capability only in a closure. No endpoint/token file is
 * published, and release aborts in-flight reads before the Reader is stopped. */
export function createUiReaderMediaProxy({ token, getPort, fetchImpl = fetch } = {}) {
  if (!hex(token) || typeof getPort !== 'function' || typeof fetchImpl !== 'function') throw fault('UI_MEDIA_OPTIONS_INVALID');
  let current;
  function publish(binding) {
    if (current) throw fault('UI_MEDIA_GENERATION_ALREADY_BOUND');
    const { reader, accountRef, selectionVersion, targets, signal, validateCurrent } = binding ?? {};
    if (!reader || !hex(accountRef) || reader.accountRef !== accountRef || !Number.isSafeInteger(selectionVersion) || selectionVersion < 1 || reader.selectionVersion !== selectionVersion ||
        !Array.isArray(targets) || targets.length > 32 || !Array.isArray(reader.targets) || targets.length !== reader.targets.length ||
        targets.some(item => !object(item) || !/^[1-9]\d{0,9}$/.test(item.id ?? '') || !hex(item.grantId) || typeof item.wxid !== 'string' || !reader.targets.includes(item.wxid)) ||
        new Set(targets.map(item => item.id)).size !== targets.length || new Set(targets.map(item => item.wxid)).size !== targets.length || !hex(reader.token) ||
        !signal || !reader.signal || typeof reader.done?.then !== 'function' || typeof validateCurrent !== 'function' || signal.aborted || reader.signal.aborted) throw fault('UI_MEDIA_BINDING_INVALID');
    const controller = new AbortController();
    const lease = { reader, accountRef, selectionVersion, targets: structuredClone(targets), base: loopback(reader.baseUrl), validateCurrent, controller };
    const release = () => { if (current === lease) current = undefined; controller.abort(fault('UI_MEDIA_GENERATION_REVOKED')); signal.removeEventListener('abort', release); reader.signal.removeEventListener('abort', release); };
    lease.release = release;
    current = lease; signal.addEventListener('abort', release, { once: true }); reader.signal.addEventListener('abort', release, { once: true });
    Promise.resolve(reader.done).then(release, release);
    return release;
  }
  function verified(lease, key, req) {
    if (!lease || current !== lease || lease.controller.signal.aborted) throw fault('UI_MEDIA_NOT_READY');
    lease.validateCurrent();
    const target = lease.targets.find(item => key === 'wechat:' + (item.wxid.endsWith('@chatroom') ? 'group' : 'private') + ':' + item.id);
    if (!target || req.headers['x-wechatagent-account'] !== lease.accountRef || req.headers['x-wechatagent-selection-version'] !== String(lease.selectionVersion) ||
        req.headers['x-wechatagent-target-grant'] !== target.grantId) throw fault('UI_MEDIA_SCOPE_REVOKED');
    return target;
  }
  async function handle(req, res) {
    if (!/^\/(?:images|media|files)(?:\/|\?|$)/.test(req.url ?? '')) return false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    const send = (status, body) => { if (!res.destroyed && !res.writableEnded) res.writeHead(status).end(JSON.stringify(body)); };
    if (req.headers.host !== `127.0.0.1:${getPort()}` || req.headers.origin !== undefined || !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { send(403, { error: 'UI_MEDIA_ORIGIN_REJECTED' }); return true; }
    if (!authorized(req.headers.authorization, token)) { send(401, { error: 'UI_MEDIA_AUTH_REQUIRED' }); return true; }
    if (req.method !== 'GET') { send(405, { error: 'UI_MEDIA_METHOD_REJECTED' }); return true; }
    let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch { send(400, { error: 'UI_MEDIA_REQUEST_INVALID' }); return true; }
    const match = /^\/(images|media|files)\/([a-f0-9]{64})$/.exec(url.pathname);
    const key=url.searchParams.get('conversationKey'),file=match?.[1]==='files',sender=url.searchParams.get('senderWxid');
    if (!match || url.searchParams.size!==(file?2:1) || !/^wechat:(private|group):[1-9]\d{0,9}$/.test(key??'') ||
        file&&(!sender||sender.length>256||/[\u0000-\u001f\u007f]/.test(sender))) { send(400, { error: 'UI_MEDIA_REQUEST_INVALID' }); return true; }
    const [, kind, id] = match, lease = current, connection = new AbortController();
    const disconnected = () => connection.abort(fault('UI_MEDIA_CLIENT_CLOSED')); res.once('close', disconnected);
    try {
      const target = verified(lease, key, req);
      if(file&&key.startsWith('wechat:private:')&&sender!==target.wxid)throw fault('UI_MEDIA_CONVERSATION_MISMATCH');
      const result = await boundedTask(async signal => {
        const response = await fetchImpl(`${lease.base}/api/v1/${kind}/${id}?${url.searchParams}`, {
          headers: { Authorization: 'Bearer ' + lease.reader.token }, redirect: 'error', signal,
        });
        const body = await responseJson(response); verified(lease, key, req); signal.throwIfAborted();
        if (!response.ok) {
          const error = typeof body?.error === 'string' && /^(?:IMAGE|MEDIA|FILE)_[A-Z0-9_]{3,80}$/.test(body.error) ? body.error : 'UI_MEDIA_READER_NOT_READY';
          return { status: [400,403,404,409,413,415,422,429,503].includes(response.status) ? response.status : 503, body: { error } };
        }
        return { status: 200, body: publicContent(kind, body, id, key,sender) };
      }, { timeoutMs: kind === 'images' ? 12000 : 120000, signal: AbortSignal.any([lease.controller.signal, connection.signal]), code: 'UI_MEDIA_TIMEOUT' });
      verified(lease, key, req);
      res.setHeader('X-WeChatAgent-Account', lease.accountRef); res.setHeader('X-WeChatAgent-Selection-Version', String(lease.selectionVersion)); res.setHeader('X-WeChatAgent-Target-Grant', target.grantId);
      send(result.status, result.body);
    } catch (error) {
      const code = /^UI_MEDIA_[A-Z0-9_]{1,70}$/.test(error?.code ?? '') ? error.code : 'UI_MEDIA_SCOPE_REVOKED';
      send(['UI_MEDIA_SCOPE_REVOKED','UI_MEDIA_CONVERSATION_MISMATCH'].includes(code) ? 403 : 503, { error: code });
    } finally { res.removeListener('close', disconnected); connection.abort(); }
    return true;
  }
  return Object.freeze({ publish, handle, close() { current?.release(); } });
}
