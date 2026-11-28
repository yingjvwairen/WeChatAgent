import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boundedTask } from './deadline.mjs';

const batchLimit = 4;

function decodeImage(content) {
  if (
    typeof content?.b64 !== 'string' ||
    content.b64.length > 1100000 ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(content.mime)
  )
    throw new Error('INVALID_IMAGE_DATA');
  const data = Buffer.from(content.b64, 'base64');
  if (
    !data.length ||
    data.length > 768 * 1024 ||
    data.toString('base64') !== content.b64 ||
    crypto.createHash('sha256').update(data).digest('hex') !== content.sha256
  )
    throw new Error('IMAGE_INTEGRITY_FAILED');
  return { data, mime: content.mime, sourceQuality: content.sourceQuality, atMs: content.atMs };
}

function isVideoFrame(content) {
  return (
    content?.sourceQuality === 'video-frame' &&
    Number.isInteger(content.atMs) &&
    content.atMs >= 0 &&
    content.atMs <= 300000
  );
}

function imageOrigin(image) {
  if (image.forwardItem !== undefined) return '合并转发第 ' + image.forwardItem + ' 条历史消息的';
  return image.quoted === true ? '被引用历史消息的' : '';
}

export async function imageBlocks(
  ctx,
  root,
  conversationKey,
  images,
  provider,
  model,
  { onUnavailable, timeoutMs = 25000, signal: parentSignal } = {},
) {
  if (!Array.isArray(images) || images.length > batchLimit) throw new Error('IMAGE_BATCH_LIMIT');
  if (!images.length) return [];
  if (
    images.some(
      image =>
        !/^[a-f0-9]{64}$/.test(image?.id ?? '') ||
        (image.forwardItem !== undefined &&
          (!Number.isInteger(image.forwardItem) || image.forwardItem < 1 || image.forwardItem > 50)),
    )
  )
    throw new Error('INVALID_IMAGE_REFERENCE');
  const llm = ctx.get('llm'),
    attachments = ctx.get('attachments');
  if (!llm || !attachments) throw new Error('NATIVE_IMAGE_SERVICES_UNAVAILABLE');
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(parentSignal ? [parentSignal] : [])]);
  const unavailableBlock = (image, index, error) => {
    if (!onUnavailable) throw error;
    // Reject the image itself on binding/integrity/format failures too. Never
    // admit its bytes, and never leave that bad input at the head of the chat.
    const safeCode = /^(?:IMAGE_[A-Z_]+|INVALID_IMAGE_DATA|MODEL_IMAGE_INPUT_UNSUPPORTED)$/.test(error.message)
      ? error.message
      : 'IMAGE_READER_NOT_READY';
    onUnavailable({
      id: image.id,
      index,
      code:
        error.imageError ??
        (error.name === 'TimeoutError' || error.name === 'AbortError' ? 'IMAGE_PROCESS_TIMEOUT' : safeCode),
    });
    return {
      type: 'text',
      text: `[本轮附图 I${index + 1} 读取失败，未提供${imageOrigin(image)}画面。不要猜测内容。其余成功附图仍可使用。]`,
    };
  };
  let info;
  try {
    info = await boundedTask(s => llm.resolveModelInfo(provider, model, s), { timeoutMs, signal });
  } catch (error) {
    return images.map((image, index) => unavailableBlock(image, index, error));
  }
  if (!info.inputModalities?.includes('image'))
    return images.map((image, index) => unavailableBlock(image, index, new Error('MODEL_IMAGE_INPUT_UNSUPPORTED')));
  const io = JSON.parse(fs.readFileSync(path.join(root, 'state/wechat-io-config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const base = new URL(io.reader_base_url);
  if (
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  )
    throw new Error('IMAGE_READER_LOOPBACK_REQUIRED');
  const maxFrames = batchLimit - images.length + 1;
  const groups = new Array(images.length);
  function saveFrame(image, frames, index) {
    const frame = frames[index];
    const name = 'wechat-image-' + image.id.slice(0, 12);
    return attachments.saveImage({
      data: frame.data,
      mediaType: frame.mime,
      name: frames.length > 1 ? name + '-' + (index + 1) : name,
    });
  }
  let next = 0;
  async function load(image, index) {
    try {
      return await boundedTask(
        async taskSignal => {
          const url = new URL('/api/v1/images/' + image.id, base);
          if (maxFrames < batchLimit) url.searchParams.set('maxFrames', String(maxFrames));
          const response = await fetch(url.href, {
            headers: { Authorization: 'Bearer ' + io.reader_token },
            redirect: 'error',
            signal: taskSignal,
          });
          if (!response.ok) {
            const failure = await response.json().catch(() => ({}));
            const error = new Error('IMAGE_READER_NOT_READY');
            if (typeof failure.error === 'string' && /^IMAGE_[A-Z_]{3,80}$/.test(failure.error))
              error.imageError = failure.error;
            throw error;
          }
          const content = await response.json();
          if (content.imageId !== image.id || content.conversationKey !== conversationKey)
            throw new Error('IMAGE_CONVERSATION_MISMATCH');
          if (content.forwardItem !== image.forwardItem) throw new Error('IMAGE_FORWARD_ITEM_MISMATCH');
          const video = Object.hasOwn(content, 'frames');
          if (
            video &&
            (!Array.isArray(content.frames) ||
              !content.frames.length ||
              content.frames.length > maxFrames ||
              !content.frames.every(isVideoFrame))
          )
            throw new Error('INVALID_IMAGE_DATA');
          const frames = (video ? content.frames : [content]).map(decodeImage);
          const primaryIndex = Math.floor(frames.length / 2);
          taskSignal.throwIfAborted();
          const attachment = await saveFrame(image, frames, primaryIndex);
          return { frames, primaryIndex, attachment, playback: video ? content.playback : undefined };
        },
        { timeoutMs: 12000, signal },
      );
    } catch (error) {
      return { unavailable: unavailableBlock(image, index, error) };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(2, images.length) }, async () => {
      while (next < images.length) {
        const index = next++;
        groups[index] = await load(images[index], index);
      }
    }),
  );
  // Keep one image per available source, then share spare slots across videos.
  const counts = groups.map(group => (group.frames ? 1 : 0));
  let spare = batchLimit - counts.reduce((total, count) => total + count, 0);
  for (let level = 1; level < maxFrames && spare; level++) {
    for (const [index, group] of groups.entries()) {
      if (spare && group.frames?.length > level) {
        counts[index]++;
        spare--;
      }
    }
  }
  const blocks = [];
  for (const [index, group] of groups.entries()) {
    if (group.unavailable) {
      blocks.push(group.unavailable);
      continue;
    }
    const { frames, primaryIndex } = group;
    const origin = imageOrigin(images[index]);
    const label = '附图 I' + (index + 1) + '，' + origin;
    const duration = group.playback?.durationSeconds;
    if (Number.isFinite(duration) && duration > 0 && duration <= 300) {
      const audio = group.playback.audioPresent === false ? '没有音轨。' : '';
      blocks.push({
        type: 'text',
        text: `[${label}视频时长 ${duration.toFixed(2)} 秒。${audio}画面仅代表采样时刻。]`,
      });
    }
    // Keep the already-admitted midpoint even when another source runs out of time.
    const selected = [...new Set([primaryIndex, 0, frames.length - 1, ...frames.keys()])]
      .slice(0, counts[index])
      .sort((a, b) => a - b);
    for (const position of selected) {
      const frame = frames[position];
      const attachment =
        position === primaryIndex
          ? group.attachment
          : await boundedTask(() => saveFrame(images[index], frames, position), { timeoutMs: 12000, signal }).catch(
              () => null,
            );
      if (!attachment) continue;
      if (isVideoFrame(frame))
        blocks.push({ type: 'text', text: `[${label}视频采样画面，时间 ${(frame.atMs / 1000).toFixed(2)} 秒]` });
      else if (origin)
        blocks.push({
          type: 'text',
          text: '[' + label + (frame.sourceQuality === 'thumbnail' ? '缩略图' : '图片') + ']',
        });
      else if (frame.sourceQuality === 'thumbnail')
        blocks.push({
          type: 'text',
          text: `[附图 I${index + 1} 当前仅提供微信本地缩略图，细节和小字可能不清楚；不要把低清画面当作原图或猜测看不清的内容。需要细节时请用户先在电脑微信打开原图，再重新发送图片。]`,
        });
      blocks.push({ type: 'image', attachment });
    }
  }
  return blocks;
}

export function offloadCompletedImages(session, sourceSeqs) {
  const targets = [];
  for (const seq of sourceSeqs) {
    const event = session.eventAt(seq);
    const message = session.deriveEventMessage ? session.deriveEventMessage(event) : event.data;
    const imageIndexes = [];
    let index = 0;
    for (const block of message.content ?? [])
      if (block.type === 'image') {
        if (!block.offloaded) imageIndexes.push(index);
        index++;
      }
    if (imageIndexes.length) targets.push({ seq, imageIndexes });
  }
  if (targets.length) session.append('image/offload', { targets });
}

export function offloadCompletedSessionImages(session) {
  // Failed/cancelled vision turns must release their image bytes too. Keeping
  // an invalid attachment active makes every later text request fail again.
  const completed = session.snapshotEvents().findLast(event => event.type === 'turn/end');
  if (!completed) return;
  const seqs = session.surface.nodes.filter(seq => {
    const event = session.eventAt(seq);
    return seq < completed.seq && event.type === 'user/message' && event.data.source?.socialImageIds?.length;
  });
  offloadCompletedImages(session, seqs);
}
