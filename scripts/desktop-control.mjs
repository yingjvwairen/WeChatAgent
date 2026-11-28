import { parseChatKey, deliveryScopeAllowed } from '../packages/wechat-identity.mjs';
import { voiceFallbackId } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const protocol = 'wechat-desktop-control-v1';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fault = (code, status = 409) => Object.assign(Error(code), { code, status });
const safeCode = error =>
  /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code ?? error?.message ?? '')
    ? (error.code ?? error.message)
    : 'DESKTOP_CONTROL_FAILED';

export function createDesktopControlClient({ root, configFor, fetchImpl = fetch }) {
  return async (body, { optional = false } = {}) => {
    const file = path.join(root, 'state/desktop/control.token');
    if (!fs.existsSync(file)) {
      if (optional) return { available: false };
      throw fault('DESKTOP_CONTROL_NOT_RUNNING');
    }
    const token = fs.readFileSync(file, 'utf8').trim(),
      port = configFor().ports.adapter;
    if (!digest(token) || !Number.isInteger(port) || port < 1024 || port > 65535)
      throw fault('DESKTOP_CONTROL_CONFIGURATION_INVALID');
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${port}/desktop/control`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      if (optional) return { available: false };
      throw fault('DESKTOP_CONTROL_NOT_RUNNING');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw fault('DESKTOP_CONTROL_RESPONSE_INVALID');
      chunks.push(chunk);
    }
    let result;
    try {
      result = JSON.parse(Buffer.concat(chunks));
    } catch {
      throw fault('DESKTOP_CONTROL_RESPONSE_INVALID');
    }
    if (!response.ok) throw fault(safeCode(result), response.status);
    if (
      result.protocol !== protocol ||
      path.resolve(result.projectRoot ?? '').toLowerCase() !== path.resolve(root).toLowerCase() ||
      result.ok !== true
    )
      throw fault('DESKTOP_CONTROL_BINDING_CHANGED');
    return { available: true, ...result.data };
  };
}

export async function executeDesktopControl(adapter, body) {
  if (
    !body ||
    Array.isArray(body) ||
    Object.keys(body).some(key => !['action', 'account', 'key', 'grant', 'id', 'revision'].includes(key))
  )
    throw fault('DESKTOP_CONTROL_INVALID', 400);
  const { action } = body;
  if (
    !['apply-configuration', 'configuration-status', 'list', 'pause', 'resume', 'cancel', 'refresh-hold'].includes(
      action,
    )
  )
    throw fault('DESKTOP_CONTROL_INVALID', 400);
  adapter.reload();
  const engine = await adapter.desktopSender.engine();
  if (action === 'apply-configuration') return engine.applyConfiguration();
  if (action === 'configuration-status') return engine.configurationStatus();
  const chat = parseChatKey(body.key);
  const scope = { accountRef: body.account, kind: chat?.kind, target: chat?.id, rosterGrant: body.grant };
  if (!chat || !deliveryScopeAllowed(adapter.project.wechat, adapter.accountRef, scope))
    throw fault('DESKTOP_CONTROL_SCOPE_CHANGED', 403);
  if (action === 'list') {
    return {
      jobs: engine.listDeliveries(scope).map(job => ({ ...job, channel: 'native' })),
      configuration: engine.configurationStatus(),
    };
  }
  if (action === 'refresh-hold') {
    engine.kick();
    return { refreshed: true };
  }
  if (!digest(body.id) || !Number.isSafeInteger(body.revision) || body.revision < 0)
    throw fault('DESKTOP_CONTROL_INVALID', 400);
  return engine.control({ ...scope, id: body.id, revision: body.revision, action });
}

/** The private adapter endpoint carries only operator commands, never text input. */
export function createDesktopControlHandler({ token, projectRoot, execute }) {
  return (req, res) => {
    if (req.url !== '/desktop/control') return false;
    const reply = (status, value) => {
      if (!res.destroyed) {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
      }
    };
    void (async () => {
      const supplied = String(req.headers.authorization ?? ''),
        expected = 'Bearer ' + token;
      let host;
      try {
        host = new URL('http://' + req.headers.host);
      } catch {}
      if (
        req.method !== 'POST' ||
        req.headers.origin ||
        !host ||
        !['127.0.0.1', 'localhost'].includes(host.hostname) ||
        Number(host.port) !== req.socket.localPort ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      )
        throw fault('DESKTOP_CONTROL_FORBIDDEN', 403);
      if (!req.headers['content-type']?.startsWith('application/json')) throw fault('DESKTOP_CONTROL_INVALID', 400);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768) throw fault('DESKTOP_CONTROL_INVALID', 413);
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks));
      } catch {
        throw fault('DESKTOP_CONTROL_INVALID', 400);
      }
      const data = await execute(body);
      reply(200, { ok: true, protocol, projectRoot: path.resolve(projectRoot), data });
    })().catch(error =>
      reply([400, 403, 409, 413].includes(error.status) ? error.status : 409, {
        error: safeCode(error),
        code: safeCode(error),
      }),
    );
    return true;
  };
}

export function mergedDeliveries(files, replies, native) {
  const nativeJobs = native.jobs ?? [];
  const replacements = new Map(nativeJobs.filter(job => job.parentId).map(job => [job.parentId, job]));
  const textParents = new Set(nativeJobs.filter(job => job.operation === 'text').map(job => job.parentId));
  return {
    ...files,
    ...replies,
    jobs: files.jobs.map(job => {
      const delivery = replacements.get(job.id);
      if (delivery?.operation !== 'file') return job;
      const view = { ...job, ...delivery, receipt: delivery.receipt, recovery: delivery.recovery };
      const saved = job.receipt;
      if (job.state !== 'confirmed' || saved?.serverConfirmed !== true) return view;
      const receipt = delivery.receipt;
      const matchesSavedReceipt =
        delivery.state === 'confirmed' &&
        delivery.confirmed === true &&
        receipt?.source === 'wechat-server-id' &&
        receipt.serverId === saved.serverId &&
        typeof receipt.fileContentMd5Matched === 'boolean' &&
        (saved.fileContentMd5Matched !== true || receipt.fileContentMd5Matched);
      if (matchesSavedReceipt) return view;
      return {
        ...view,
        state: 'confirmed',
        confirmed: true,
        pending: false,
        submitted: true,
        submission: 'confirmed',
        receipt: saved,
        reason: null,
        canPause: false,
        canResume: false,
        canCancel: false,
      };
    }),
    replies: replies.replies.filter(
      job => !replacements.has(job.id) && (job.kind !== 'voice' || !textParents.has(voiceFallbackId(job.id))),
    ),
    native: nativeJobs.filter(job => job.operation !== 'file' || !files.jobs.some(file => file.id === job.parentId)),
    desktopAvailable: native.available === true,
  };
}
