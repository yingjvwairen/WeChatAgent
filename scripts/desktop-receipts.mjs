import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { voicePcm } from './decode-wechat-voice.mjs';
import { voiceShape } from './recorded-voice-match.mjs';
import { foregroundQuoteCandidate, sameMessageText } from './foreground-quote.mjs';
import { RECEIPT_BASELINE_UNAVAILABLE } from '../packages/delivery-contract.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validId = value => /^[1-9]\d{0,31}$/u.test(String(value ?? ''));
const receiptFile = root => path.join(root, 'state/desktop/receipts.sqlite');
const sameImageMd5 = (job, row) => /^[a-f0-9]{32}$/.test(job.md5) && row.imageMd5 === job.md5;
const hasSubmission = state => state?.submittedAt !== undefined || Boolean(state?.receipt);
const sameRecording = (left, right) => left?.startedAt === right?.startedAt && left?.releasedAt === right?.releasedAt;

function journal(file, write, run) {
  if (write) fs.mkdirSync(path.dirname(file), { recursive: true });
  else if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout=1000');
    if (write) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS claims (
          account TEXT NOT NULL, server_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
          PRIMARY KEY (account, server_id)
        );`);
    } else if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attempts'").get()) {
      return null;
    }
    const result = run(db);
    if (write) db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}

function saveState(db, state) {
  db.prepare('INSERT OR REPLACE INTO attempts (id, body) VALUES (?, ?)').run(state.key, JSON.stringify(state));
  return state;
}
function rowKey(row) {
  if (!/^[a-f0-9]{64}$/.test(row.sourceShard ?? '') || !validId(row.localId)) {
    throw Error('DESKTOP_RECEIPT_ROW_ID_INVALID');
  }
  return row.sourceShard + ':' + row.localId;
}
const quoteType = 57 * 2 ** 32 + 49,
  fileType = 6 * 2 ** 32 + 49,
  gifType = 8 * 2 ** 32 + 49;

const receiptKey = job =>
  hash(
    JSON.stringify([
      job.accountRef,
      job.deliveryId,
      job.segment?.attemptId ?? job.segment?.id ?? job.id,
      job.operation,
    ]),
  );
const receiptDigest = job =>
  hash(
    JSON.stringify({
      kind: job.kind,
      target: job.target,
      text: job.text ?? null,
      path: job.path ?? null,
      md5: job.md5 ?? null,
      ...(job.imageFingerprint ? { sha256: job.sha256, imageFingerprint: job.imageFingerprint } : {}),
      size: job.size ?? null,
      fileName: job.fileName ?? null,
      quote: job.quote ?? null,
      segment: job.segment ?? null,
      pcm: job.pcmBase64 ? hash(job.pcmBase64) : null,
    }),
  );

function receiptWindow(state, voice) {
  // Ordinary messages must originate in the submission second or later.
  // Acoustic matching tolerates one second of clock skew and a bounded upload grace period.
  const after = Math.floor((state.recording?.startedAt ?? state.submittedAt) / 1000) - Number(voice);
  const before = Math.min(
    after + 120,
    Math.floor(
      (state.recording?.releasedAt ?? state.submittedAt + (voice ? Math.max(60000, state.durationMs + 30000) : 60000)) /
        1000,
    ) + (voice ? 30 : 4),
  );
  return { after, before };
}

const receiptLookup = db => db.prepare('SELECT body FROM attempts WHERE id = ?');
function receiptState(lookup, key, job, digest) {
  const row = lookup.get(key);
  if (!row) return null;
  const state = JSON.parse(row.body);
  if (
    state?.key !== key ||
    state.digest !== digest ||
    state.accountRef !== job.accountRef ||
    state.target !== job.target
  )
    throw Error('DESKTOP_RECEIPT_BINDING_CHANGED');
  return state;
}

function savedReceiptState(root, job) {
  return journal(receiptFile(root), false, db =>
    receiptState(receiptLookup(db), receiptKey(job), job, receiptDigest(job)),
  );
}

export function savedDesktopReceipt(root, job) {
  return savedReceiptState(root, job)?.receipt;
}

export function savedDesktopReceipts(root, jobs) {
  const receipts = new Map();
  if (!jobs.length) return receipts;
  try {
    journal(receiptFile(root), false, db => {
      const lookup = receiptLookup(db);
      for (const job of jobs) {
        try {
          const receipt = receiptState(lookup, receiptKey(job), job, receiptDigest(job))?.receipt;
          if (receipt) receipts.set(job, receipt);
        } catch {
          // An unusable attempt must not hide the other jobs in the chat.
        }
      }
    });
  } catch {
    // An unavailable journal leaves the affected deliveries unconfirmed.
  }
  return receipts;
}

export function savedDesktopSubmission(root, job) {
  const state = savedReceiptState(root, job);
  return /^[a-f0-9]{64}$/.test(state?.baselineId ?? '') ? hasSubmission(state) : null;
}

/** Per-attempt baselines survive queue pauses and split voice segments. */
export class DesktopReceipts {
  constructor(root, { messages, recordingReceipt, authorize, now = Date.now }) {
    this.file = receiptFile(root);
    this.messages = messages;
    this.recordingReceipt = recordingReceipt;
    this.authorize = authorize;
    this.now = now;
  }
  key(job) {
    return receiptKey(job);
  }
  async observe(job, request = {}) {
    const forInput = request.phase === 'prepare' || (request.phase === 'submitted' && !request.recording);
    if (!['text', 'voice', 'image', 'sticker', 'file'].includes(job.operation))
      throw Error('DESKTOP_RECEIPT_OPERATION_INVALID');
    const key = this.key(job),
      digest = receiptDigest(job),
      readState = db => receiptState(receiptLookup(db), key, job, digest);
    const authorized = async () => {
      const granted = await this.authorize(job, forInput);
      if (granted === true) return null;
      const reason = 'DESKTOP_RECEIPT_PERMISSION_CHANGED';
      if (granted === false && forInput && job.operation !== 'voice' && (await this.authorize(job, false)) === true) {
        const state = journal(this.file, false, readState);
        const preparing = request.phase === 'prepare';
        const matchingBaseline =
          typeof request.baselineId === 'string' && state?.baselineId === request.baselineId && !state.reprepare;
        // A refused reservation proves absence only under the saved receipt scope and before any recorded submit.
        if (!hasSubmission(state) && (preparing || matchingBaseline))
          return {
            ...(preparing ? { prepared: false, submissionAllowed: false } : { recorded: false }),
            performed: false,
            attempted: false,
            reason,
          };
      }
      throw Error(reason);
    };
    const refusal = await authorized();
    if (refusal) return refusal;
    if (request.phase === 'prepare') {
      let state = journal(this.file, false, readState);
      // A pause can leave a baseline without any submission. Refresh it on the next ordinary attempt.
      if (!hasSubmission(state) && (!state || state.reprepare === true || job.operation !== 'voice')) {
        const startedAt = this.now();
        const second = Math.floor(startedAt / 1000);
        let baseline;
        try {
          baseline = await this.messages(job.target, {
            after: second - 1,
            before: second + 1,
            baseline: '1',
          });
        } catch (error) {
          if (job.operation === 'voice') throw error;
          const refusal = await authorized();
          if (refusal) return refusal;
          const current = journal(this.file, false, readState);
          if (hasSubmission(current))
            return { prepared: true, submissionAllowed: false, baselineId: current.baselineId };
          // Reader preparation cannot have started desktop input.
          return {
            prepared: false,
            submissionAllowed: false,
            performed: false,
            attempted: false,
            reason: RECEIPT_BASELINE_UNAVAILABLE,
          };
        }
        const { messages: rows, watermarks } = baseline;
        if (
          !watermarks ||
          typeof watermarks !== 'object' ||
          Array.isArray(watermarks) ||
          Object.entries(watermarks).some(
            ([shard, value]) => !/^[a-f0-9]{64}$/.test(shard) || typeof value !== 'string' || !/^\d{1,19}$/.test(value),
          )
        )
          throw Error('DESKTOP_RECEIPT_BASELINE_INVALID');
        const refusal = await authorized();
        if (refusal) return refusal;
        const prepared = {
          key,
          digest,
          accountRef: job.accountRef,
          accountWxid: job.accountWxid,
          operation: job.operation,
          target: job.target,
          startedAt,
          baselineId: hash(key + '\0' + crypto.randomUUID()),
          watermarks,
          baselineRows: rows.map(rowKey),
          serverBaseline: rows.filter(row => validId(row.serverId)).map(row => String(row.serverId)),
          ...(job.imageFingerprint ? { imageFingerprint: job.imageFingerprint } : {}),
          ...(state?.intentHistory ? { intentHistory: state.intentHistory } : {}),
        };
        if (job.operation === 'voice') {
          const pcm = job.segment?.path
            ? voicePcm(fs.readFileSync(job.segment.path))
            : Buffer.from(job.pcmBase64, 'base64');
          prepared.shape = voiceShape(pcm);
          prepared.durationMs = Math.ceil(pcm.length / 32);
        }
        state = journal(this.file, true, db => {
          const current = readState(db);
          if (hasSubmission(current) || (current && !current.reprepare && current.baselineId !== state?.baselineId))
            return current;
          if (current?.baselineId !== state?.baselineId || current?.reprepare !== state?.reprepare)
            throw Error('DESKTOP_RECEIPT_BASELINE_CHANGED');
          return saveState(db, prepared);
        });
      }
      return { prepared: true, submissionAllowed: !hasSubmission(state), baselineId: state.baselineId };
    }
    if (request.phase !== 'query') return journal(this.file, true, db => this.#record(db, readState(db), job, request));
    let state = journal(this.file, false, readState);
    if (!state) throw Error('DESKTOP_RECEIPT_BASELINE_REQUIRED');
    if (!state.receipt && !state.submittedAt) return { confirmed: false, reason: 'DESKTOP_RECEIPT_NOT_SUBMITTED' };
    const recording = job.operation === 'voice' ? request.recording : undefined;
    if (recording && !state.receipt && !state.recording) {
      state = journal(this.file, true, db => {
        const current = readState(db);
        if (current?.baselineId !== state.baselineId || current.submittedAt !== state.submittedAt)
          throw Error('DESKTOP_RECEIPT_BASELINE_CHANGED');
        if (!current.receipt && !current.recording)
          this.#record(db, current, job, { phase: 'submitted', submittedAt: current.submittedAt, recording });
        return current;
      });
    }
    if (state.receipt) return { confirmed: true, receipt: state.receipt };
    if (recording && !sameRecording(state.recording, recording))
      return { confirmed: false, reason: 'DESKTOP_RECEIPT_RECORDING_CHANGED' };
    return this.#reconcile(job, state, authorized);
  }

  #record(db, state, job, request) {
    if (!state) throw Error('DESKTOP_RECEIPT_BASELINE_REQUIRED');
    if (request.phase === 'not-attempted') {
      if (
        job.operation === 'voice' ||
        request.baselineId !== state.baselineId ||
        request.proof?.performed !== false ||
        request.proof?.attempted !== false ||
        state.receipt ||
        state.recording ||
        !state.submittedAt
      )
        throw Error('DESKTOP_RECEIPT_RELEASE_INVALID');
      state.intentHistory = [
        ...(state.intentHistory ?? []),
        { submittedAt: state.submittedAt, releasedAt: this.now(), outcome: 'not-attempted' },
      ].slice(-128);
      delete state.submittedAt;
      delete state.window;
      state.reprepare = true;
      saveState(db, state);
      return { released: true, baselineId: state.baselineId };
    }
    if (request.phase === 'submitted') {
      if (state.reprepare) throw Error('DESKTOP_RECEIPT_BASELINE_REQUIRED');
      if (request.baselineId !== undefined && request.baselineId !== state.baselineId)
        throw Error('DESKTOP_RECEIPT_BASELINE_CHANGED');
      // Voice adds recording timing to its original reservation after native input.
      if (job.operation !== 'voice' && hasSubmission(state)) throw Error('DESKTOP_RECEIPT_SUBMISSION_RESERVED');
      const at = request.submittedAt ?? this.now();
      if (!Number.isSafeInteger(at) || at < state.startedAt - 1000 || at > this.now() + 1000)
        throw Error('DESKTOP_RECEIPT_SUBMIT_TIME_INVALID');
      state.submittedAt ??= at;
      if (request.recording) {
        const { startedAt, releasedAt } = request.recording;
        if (
          !Number.isSafeInteger(startedAt) ||
          !Number.isSafeInteger(releasedAt) ||
          startedAt < state.submittedAt - 1000 ||
          releasedAt < startedAt ||
          releasedAt - startedAt > 115000 ||
          releasedAt > this.now() + 1000
        )
          throw Error('DESKTOP_RECEIPT_RECORDING_INVALID');
        state.recording = { startedAt, releasedAt };
      }
      state.window = receiptWindow(state, job.operation === 'voice');
      saveState(db, state);
      return { recorded: true, baselineId: state.baselineId };
    }
    throw Error('DESKTOP_RECEIPT_PHASE_INVALID');
  }

  async #reconcile(job, state, authorized) {
    const voice = job.operation === 'voice';
    const { after, before } = state.window;
    const proof = state.key + ':' + state.baselineId;
    const newRow = row =>
      (row.isSend === 1 || row.isSend === true) &&
      validId(row.localId) &&
      !state.baselineRows.includes(rowKey(row)) &&
      BigInt(row.localId) > BigInt(state.watermarks[row.sourceShard] ?? 0) &&
      !state.serverBaseline.includes(String(row.serverId)) &&
      Number.isSafeInteger(row.createTime) &&
      row.createTime >= after &&
      row.createTime <= before;
    const gif = job.operation === 'sticker' || (job.operation === 'image' && /\.gif$/iu.test(job.path ?? ''));
    const staticImage = job.operation === 'image' && !gif;
    let matches = [],
      reason = 'DESKTOP_RECEIPT_PENDING';
    if (voice) {
      const result = await this.recordingReceipt(
        {
          talker: job.target,
          account: job.accountWxid,
          after,
          before,
          baseline: [],
          watermarks: state.watermarks,
          shape: state.shape,
          durationMs: state.durationMs,
        },
        proof,
      );
      if (result?.success && result.match && newRow({ ...result.match, isSend: true }))
        matches = [{ ...result.match, localType: 34 }];
    } else {
      const { messages: rows } = await this.messages(job.target, { after, before }, proof);
      matches = rows.filter(row => {
        // A row awaiting a server ID can still compete with an acknowledged row.
        if (!newRow(row)) return false;
        if (job.operation === 'text') {
          if (job.quote)
            return [49, quoteType].includes(row.localType) && foregroundQuoteCandidate(row, job.quote, job.text);
          return row.localType === 1 && sameMessageText(row.fullText ?? row.content, job.text);
        }
        if (job.operation === 'file')
          return (
            [49, fileType].includes(row.localType) &&
            row.fileKind === 'appmsg-6' &&
            row.fileName === (job.fileName ?? path.basename(job.path)) &&
            row.fileSize === job.size &&
            (!row.fileMd5 || row.fileMd5 === job.md5)
          );
        if (gif)
          return (
            ([47, gifType].includes(row.localType) && row.stickerMd5 === job.md5) ||
            (row.localType === 49 && row.stickerKind === 'appmsg-8' && row.stickerMd5 === job.md5)
          );
        return (
          row.localType === 3 && (sameImageMd5(job, row) || (state.imageFingerprint && row.imageRasterMatched === true))
        );
      });
      if (job.operation === 'file' && !matches.some(row => !row.fileMd5 && !validId(row.serverId))) {
        const exact = matches.filter(row => row.fileMd5 === job.md5);
        if (exact.length) matches = exact;
      }
      // A fresh image row with no content match remains unclaimed.
      if (!matches.length && staticImage && rows.some(row => row.localType === 3 && newRow(row)))
        reason = 'DESKTOP_IMAGE_CONTENT_UNVERIFIED';
      if (
        staticImage &&
        matches.length === 1 &&
        !sameImageMd5(job, matches[0]) &&
        rows.some(row => row.localType === 3 && row !== matches[0] && newRow(row) && row.imageRasterMatched !== false)
      ) {
        matches = [];
        reason = 'DESKTOP_RECEIPT_AMBIGUOUS';
      }
    }
    await authorized();
    return journal(this.file, true, db => {
      // Database observations can overlap a refusal, a refreshed baseline or
      // another query. Compare with the durable attempt before claiming a row.
      const current = receiptState(receiptLookup(db), state.key, job, state.digest);
      if (
        current?.baselineId !== state.baselineId ||
        current.submittedAt !== state.submittedAt ||
        !sameRecording(current.recording, state.recording)
      )
        return { confirmed: false, reason: 'DESKTOP_RECEIPT_BASELINE_CHANGED' };
      if (current.receipt) return { confirmed: true, receipt: current.receipt };
      const match = matches.length === 1 ? matches[0] : null;
      const evidence = match && validId(match.serverId) ? this.#evidence(job, match, { gif, staticImage }) : null;
      if (!evidence) return { confirmed: false, reason: matches.length > 1 ? 'DESKTOP_RECEIPT_AMBIGUOUS' : reason };
      // Keep one server message per delivery even when the available proof
      // establishes an outgoing message and leaves its bytes unverified.
      const claim = db
        .prepare('INSERT OR IGNORE INTO claims (account, server_id, attempt_id) VALUES (?, ?, ?)')
        .run(job.accountRef, evidence.serverId, current.key);
      if (!claim.changes) return { confirmed: false, reason: 'DESKTOP_RECEIPT_ALREADY_CLAIMED' };
      current.receipt = evidence;
      saveState(db, current);
      return { confirmed: true, receipt: current.receipt };
    });
  }

  #evidence(job, match, { gif, staticImage }) {
    return {
      sourceShard: match.sourceShard,
      serverId: String(match.serverId),
      localId: String(match.localId),
      createTime: match.createTime,
      localType: match.localType,
      source: job.operation === 'voice' ? 'desktop-acoustic-match' : 'wechat-server-id',
      ...(job.quote ? { sourceServerId: String(match.quoteSourceServerId) } : {}),
      ...(gif
        ? {
            sourceImageMd5: job.md5,
            gifContentMd5Matched: true,
            nativeImageRowConfirmed: true,
            imageContentVerified: false,
          }
        : {}),
      ...(staticImage
        ? {
            nativeImageRowConfirmed: true,
            sourceImageSha256: job.sha256,
            imageContentMatch: sameImageMd5(job, match) ? 'source-md5' : 'raster',
            imageContentVerified: false,
          }
        : {}),
      ...(job.operation === 'file'
        ? {
            fileName: match.fileName,
            fileSize: match.fileSize,
            fileContentMd5Matched: !!match.fileMd5,
            ...(match.fileMd5 ? { fileMd5: match.fileMd5 } : {}),
          }
        : {}),
    };
  }
}
