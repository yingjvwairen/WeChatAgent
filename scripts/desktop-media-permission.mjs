import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileTransfers, fileDeliveryFinished } from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import { ReplyMediaCatalog } from './reply-media-catalog.mjs';
import { stickerPolicy } from '../components/qq-bridge/src/core/sticker-policy.js';
import { memeLibraryPolicy } from '../packages/dsh-social-bridge-plugin/meme-library-policy.mjs';
import { allowedConversation } from '../packages/wechat-identity.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// The same current grant is checked again at native resume boundaries. These
// checks use the existing file/material stores rather than a second ACL.
export function desktopMediaAllowed(root, config, job, forInput = true) {
  const key = 'wechat:' + job.kind + ':' + job.target;
  try {
    if (job.fileDeliveryId) {
      const store = new FileTransfers(root),
        source = store.read(job.fileDeliveryId);
      return (
        source.key === key &&
        source.accountScope === job.accountRef &&
        source.rosterGrant === job.rosterGrant &&
        !['cancelled', 'expired', 'failed'].includes(source.state) &&
        store.allowedJob(source) &&
        source.sha256 === job.sha256 &&
        source.md5 === job.md5 &&
        source.size === job.size &&
        source.name === job.fileName &&
        (!forInput ||
          (!fileDeliveryFinished(source.state) &&
            path.resolve(store.staged(source)).toLowerCase() === path.resolve(job.path).toLowerCase()))
      );
    }
    if (job.operation === 'file') return false;
    if (!['image', 'sticker'].includes(job.operation)) return true;
    if (!stickerPolicy(config.wechat, key).enabled) return false;
    if (job.localReference) {
      const catalog = new ReplyMediaCatalog({ root });
      if (job.localReference.id !== job.sha256 || job.localReference.sha256 !== job.sha256) return false;
      if (!forInput) {
        const { enabled, items } = catalog.snapshot();
        return enabled && items.some(item => item.id === job.sha256);
      }
      const asset = catalog.resolve(job.localReference.id);
      return asset.md5 === job.md5 && path.resolve(asset.path).toLowerCase() === path.resolve(job.path).toLowerCase();
    }
    const accountPath = path.resolve(job.accountDirectory ?? job.account);
    const scope = hash(
      (process.platform === 'win32' ? accountPath.toLowerCase() : accountPath) + '|' + job.accountWxid,
    );
    if (job.temporaryReference) {
      const ref = job.temporaryReference;
      if (
        ref.id !== hash('meme-send:' + scope + ':' + key + ':' + job.sha256) ||
        !/^[a-f0-9]{32}$/.test(ref.generation ?? '') ||
        ref.sha256 !== job.sha256 ||
        !memeLibraryPolicy(config.wechat, key).enabled
      )
        return false;
      // A receipt can outlive the Reader that prepared the original input.
      if (!forInput) return true;
      const directory = path.join(root, 'state/stickers/collected', scope.slice(0, 32), 'prepared');
      const generation = JSON.parse(fs.readFileSync(path.join(directory, 'generation.json'), 'utf8'));
      if (!Number.isInteger(generation.pid) || generation.pid <= 0) return false;
      process.kill(generation.pid, 0);
      const grant = JSON.parse(fs.readFileSync(path.join(directory, ref.id + '.json'), 'utf8'));
      const expected = path.join(root, 'state/stickers/outgoing', job.md5 + '.gif');
      return (
        generation.generation === ref.generation &&
        grant.generation === ref.generation &&
        grant.accountScope === scope &&
        grant.conversationKey === key &&
        grant.id === ref.id &&
        grant.sha256 === job.sha256 &&
        grant.md5 === job.md5 &&
        grant.size === job.size &&
        Number.isSafeInteger(grant.expiresAt) &&
        Date.now() < grant.expiresAt &&
        path.resolve(expected).toLowerCase() === path.resolve(job.path).toLowerCase() &&
        fs.statSync(expected).size === job.size &&
        hash(fs.readFileSync(expected)) === job.sha256
      );
    }
    if (!/^[a-f0-9]{64}$/.test(job.poolReference ?? '')) return false;
    const index = JSON.parse(
      fs.readFileSync(path.join(root, 'state/stickers/collected', scope.slice(0, 32), 'index.json'), 'utf8'),
    );
    const shared = (config.wechat.stickers?.shareEnabled ?? config.wechat.stickers?.shareGroups ?? true) === true;
    return (
      index.account === scope &&
      Object.entries(index.entries ?? {}).some(
        ([digest, item]) =>
          hash('group-sticker:' + scope + ':' + key + ':' + digest) === job.poolReference &&
          digest === job.sha256 &&
          item.fields?.md5 === job.md5 &&
          item.fields?.len === job.size &&
          (item.manual === true ||
            Object.hasOwn(item.sources ?? {}, key) ||
            (shared && Object.keys(item.sources ?? {}).some(source => allowedConversation(config.wechat, source)))),
      )
    );
  } catch {
    return false;
  }
}
