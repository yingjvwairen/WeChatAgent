import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { voicePcm } from './decode-wechat-voice.mjs';
import { voiceShape } from './recorded-voice-match.mjs';
import { foregroundQuoteCandidate, sameMessageText } from './foreground-quote.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validId = value => /^[1-9]\d{0,31}$/u.test(String(value ?? ''));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const atomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
function rowKey(row) {
  if (!/^[a-f0-9]{64}$/.test(row.sourceShard ?? '') || !validId(row.localId)) {
    throw Error('DESKTOP_RECEIPT_ROW_ID_INVALID');
  }
  return row.sourceShard + ':' + row.localId;
}
const quoteType = 57 * 2 ** 32 + 49,
  fileType = 6 * 2 ** 32 + 49,
  gifType = 8 * 2 ** 32 + 49;

/** Per-attempt baselines survive queue pauses and split voice segments. */
export class DesktopReceipts {
  constructor(root, { messages, recordingReceipt, authorize, now = Date.now }) {
    this.root = root;
    this.messages = messages;
    this.recordingReceipt = recordingReceipt;
    this.authorize = authorize;
    this.now = now;
  }
  key(job) {
    return hash(
      JSON.stringify([
        job.accountRef,
        job.deliveryId,
        job.segment?.attemptId ?? job.segment?.id ?? job.id,
        job.operation,
      ]),
    );
  }
  async observe(job, request = {}) {
    const authorized = async () => {
      if ((await this.authorize(job)) !== true) throw Error('DESKTOP_RECEIPT_PERMISSION_CHANGED');
    };
    await authorized();
    if (!['text', 'voice', 'image', 'sticker', 'file'].includes(job.operation))
      throw Error('DESKTOP_RECEIPT_OPERATION_INVALID');
    const key = this.key(job),
      file = path.join(this.root, 'state/desktop/receipts', key + '.json');
    const digest = hash(
      JSON.stringify({
        kind: job.kind,
        target: job.target,
        text: job.text ?? null,
        path: job.path ?? null,
        md5: job.md5 ?? null,
        size: job.size ?? null,
        fileName: job.fileName ?? null,
        quote: job.quote ?? null,
        segment: job.segment ?? null,
        pcm: job.pcmBase64 ? hash(job.pcmBase64) : null,
      }),
    );
    let state = fs.existsSync(file) ? read(file) : null;
    if (
      state &&
      (state.version !== 2 ||
        state.digest !== digest ||
        state.accountRef !== job.accountRef ||
        state.target !== job.target)
    )
      throw Error('DESKTOP_RECEIPT_BINDING_CHANGED');
    if (request.phase === 'prepare') {
      if (!state || state.reprepare === true) {
        const startedAt = this.now();
        const second = Math.floor(startedAt / 1000);
        const { messages: rows, watermarks } = await this.messages(job.target, {
          after: second - 1,
          before: second + 1,
          baseline: '1',
        });
        if (
          !watermarks ||
          typeof watermarks !== 'object' ||
          Array.isArray(watermarks) ||
          Object.entries(watermarks).some(
            ([shard, value]) => !/^[a-f0-9]{64}$/.test(shard) || typeof value !== 'string' || !/^\d{1,19}$/.test(value),
          )
        )
          throw Error('DESKTOP_RECEIPT_BASELINE_INVALID');
        await authorized();
        state = {
          version: 2,
          key,
          digest,
          accountRef: job.accountRef,
          target: job.target,
          startedAt,
          baselineId: hash(key + '\0' + crypto.randomUUID()),
          watermarks,
          baselineRows: rows.map(rowKey),
          serverBaseline: rows.filter(row => validId(row.serverId)).map(row => String(row.serverId)),
          ...(state?.intentHistory ? { intentHistory: state.intentHistory } : {}),
        };
        if (job.operation === 'voice') {
          const pcm = job.segment?.path
            ? voicePcm(fs.readFileSync(job.segment.path))
            : Buffer.from(job.pcmBase64, 'base64');
          state.shape = voiceShape(pcm);
          state.durationMs = Math.ceil(pcm.length / 32);
        }
        atomic(file, state);
      }
      return { prepared: true, submissionAllowed: !state.submittedAt && !state.receipt, baselineId: state.baselineId };
    }
    if (!state) throw Error('DESKTOP_RECEIPT_BASELINE_REQUIRED');
    if (request.phase === 'image-input-applied') {
      if (job.operation !== 'image' || !state.submittedAt || state.baselineId !== request.baselineId)
        throw Error('DESKTOP_RECEIPT_BASELINE_CHANGED');
      state.imageAppliedAt ??= this.now();
      atomic(file, state);
      return { recorded: true };
    }
    if (request.phase === 'not-attempted') {
      if (
        job.operation === 'voice' ||
        request.baselineId !== state.baselineId ||
        request.proof?.performed !== false ||
        request.proof?.attempted !== false ||
        state.imageAppliedAt ||
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
      state.reprepare = true;
      atomic(file, state);
      return { released: true, baselineId: state.baselineId };
    }
    if (request.phase === 'submitted') {
      if (state.reprepare) throw Error('DESKTOP_RECEIPT_BASELINE_REQUIRED');
      if (request.baselineId !== undefined && request.baselineId !== state.baselineId)
        throw Error('DESKTOP_RECEIPT_BASELINE_CHANGED');
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
      atomic(file, state);
      return { recorded: true, baselineId: state.baselineId };
    }
    if (request.phase !== 'query') throw Error('DESKTOP_RECEIPT_PHASE_INVALID');
    if (state.receipt) return { confirmed: true, receipt: state.receipt };
    if (!state.submittedAt) return { confirmed: false, reason: 'DESKTOP_RECEIPT_NOT_SUBMITTED' };
    const voice = job.operation === 'voice';
    // Only acoustic matching tolerates timestamp skew. Ordinary messages must
    // originate in the submission second or later, even if their rows appeared late.
    const after = Math.floor((state.recording?.startedAt ?? state.submittedAt) / 1000) - Number(voice);
    // A missing native acknowledgement still has a durable intent. Reconcile
    // within its fixed window; repeated polling cannot admit a later message.
    // WeChat may timestamp the outgoing voice when its upload completes,
    // several seconds after the local recorder closes. Keep a fixed grace
    // window tied to this attempt, still bounded by the Reader's 120s range.
    const before = Math.min(
      after + 120,
      Math.floor(
        (state.recording?.releasedAt ??
          state.submittedAt + (voice ? Math.max(60000, state.durationMs + 30000) : 60000)) / 1000,
      ) + (voice ? 30 : 4),
    );
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
    let matches = [];
    if (voice) {
      const result = await this.recordingReceipt({
        talker: job.target,
        account: job.accountWxid,
        after,
        before,
        baseline: [],
        watermarks: state.watermarks,
        shape: state.shape,
        durationMs: state.durationMs,
        ...(job.voicePlugin ? { voicePlugin: job.voicePlugin, target: job.target } : {}),
      });
      if (result?.success && result.match && newRow({ ...result.match, isSend: true }))
        matches = [{ ...result.match, localType: 34 }];
    } else {
      const { messages: rows } = await this.messages(job.target, { after, before });
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
        return row.localType === 3 && /^[a-f0-9]{32}$/.test(job.md5) && row.imageMd5 === job.md5;
      });
      if (!matches.length && !gif && job.operation === 'image') {
        const candidates = rows.filter(row => row.localType === 3 && newRow(row));
        if (candidates.length) {
          await authorized();
          if (candidates.length !== 1) return { confirmed: false, reason: 'DESKTOP_RECEIPT_AMBIGUOUS' };
          if (
            !state.imageAppliedAt ||
            candidates[0].createTime > Math.floor(state.imageAppliedAt / 1000) + 4 ||
            !validId(candidates[0].serverId)
          )
            return { confirmed: false, reason: 'DESKTOP_IMAGE_CONTENT_UNVERIFIED' };
          matches = candidates;
        }
      }
    }
    await authorized();
    if (matches.length !== 1)
      return { confirmed: false, reason: matches.length ? 'DESKTOP_RECEIPT_AMBIGUOUS' : 'DESKTOP_RECEIPT_PENDING' };
    const match = matches[0];
    if (!validId(match.serverId)) return { confirmed: false, reason: 'DESKTOP_RECEIPT_PENDING' };
    // A server message may acknowledge exactly one native attempt, including
    // separate voice segments and equal consecutive text replies.
    const claim = path.join(
      this.root,
      'state/desktop/receipt-claims',
      hash(job.accountRef + '\0' + match.serverId) + '.json',
    );
    fs.mkdirSync(path.dirname(claim), { recursive: true });
    try {
      fs.writeFileSync(claim, JSON.stringify({ key }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (read(claim).key !== key) return { confirmed: false, reason: 'DESKTOP_RECEIPT_ALREADY_CLAIMED' };
    }
    state.receipt = {
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
      ...(job.operation === 'image' && !gif
        ? {
            nativeImageRowConfirmed: true,
            sourceImageMd5: job.md5,
            sourceMd5Matched: match.imageMd5 === job.md5,
            nativeSubmitVerified: Boolean(state.imageAppliedAt),
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
    atomic(file, state);
    return { confirmed: true, receipt: state.receipt };
  }
}
