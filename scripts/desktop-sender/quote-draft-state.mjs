import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deliveryNoLinks } from './delivery-archive.mjs';

const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const fault = () => Object.assign(Error('UI_QT_QUOTE_SCOPE_INVALID'), { code: 'UI_QT_QUOTE_SCOPE_INVALID' });

export function quoteDraftFile(root, accountRef, target) {
  if (!path.isAbsolute(root) || !digest(accountRef) || typeof target !== 'string' || !target) throw fault();
  const name = crypto.createHash('sha256').update(target).digest('hex');
  const file = path.join(root, 'state/ui-quote-drafts', accountRef, name + '.json');
  deliveryNoLinks(file);
  return file;
}

export function readQuoteDraft(root, accountRef, target) {
  const file = quoteDraftFile(root, accountRef, target);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!digest(value.id) || typeof value.bound !== 'boolean' || !['ocr', 'uia'].includes(value.mode)) throw fault();
  return value;
}

export function beginQuoteDraft(root, accountRef, target, id, mode) {
  if (!digest(id) || !['ocr', 'uia'].includes(mode)) throw fault();
  const file = quoteDraftFile(root, accountRef, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id, bound: false, mode }), { flag: 'wx', flush: true });
}

export function bindQuoteDraft(root, accountRef, target, id, mode) {
  if (readQuoteDraft(root, accountRef, target)?.id !== id || !['ocr', 'uia'].includes(mode)) throw fault();
  const file = quoteDraftFile(root, accountRef, target),
    temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify({ id, bound: true, mode }), { flag: 'wx', flush: true });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

// Both receipt confirmation and reviewed recovery clear only their own marker.
// A subsequent delivery's draft must never be erased by an old confirmation.
export function confirmQuoteDraftSent(root, accountRef, target, id) {
  if (!digest(id)) throw fault();
  if (readQuoteDraft(root, accountRef, target)?.id !== id) return false;
  fs.unlinkSync(quoteDraftFile(root, accountRef, target));
  return true;
}
