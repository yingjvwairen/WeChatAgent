import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MAX_CATALOG_BYTES, ReplyMediaCatalog } from './reply-media-catalog.mjs';

export function importReplyMedia(source, root) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) throw Error('REPLY_MEDIA_IMPORT_INVALID');
  const manifest = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  if (manifest?.version !== 1 || Object.keys(manifest).some(key => !['version', 'enabled', 'items'].includes(key)))
    throw Error('REPLY_MEDIA_IMPORT_INVALID');
  if (manifest.enabled !== undefined && typeof manifest.enabled !== 'boolean')
    throw Object.assign(Error('REPLY_MEDIA_CONFIG_INVALID'), { code: 'REPLY_MEDIA_CONFIG_INVALID' });
  return new ReplyMediaCatalog({ root }).importIntoEmpty({ items: manifest.items });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, root: { type: 'string' } } });
  if (!values.source) throw Error('请用 --source 指定旧素材库配置文件。');
  const result = importReplyMedia(
    path.resolve(values.source),
    path.resolve(values.root ?? path.join(import.meta.dirname, '..')),
  );
  console.log('已导入素材数', result.items.length);
}
