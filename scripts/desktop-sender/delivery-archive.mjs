import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fault = code => Object.assign(new Error(code), { code });
const idPattern = /^[a-f0-9]{64}$/;
export function deliveryNoLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('DELIVERY_ARCHIVE_LINK_REJECTED');
    if (path.dirname(item) === item) return;
  }
}
export function boundedDeliveryNames(directory, { directories = false, maximumEntries = 4096 } = {}) {
  deliveryNoLinks(directory);
  const result = [],
    iterator = fs.opendirSync(directory);
  let count = 0;
  try {
    for (let item; (item = iterator.readSync()) !== null;) {
      if (++count > maximumEntries) throw fault('DELIVERY_ACTIVE_DIRECTORY_LIMIT');
      if ((directories ? idPattern : /^[a-f0-9]{64}\.json$/).test(item.name)) {
        if (item.isSymbolicLink() || (directories ? !item.isDirectory() : !item.isFile()))
          throw fault('DELIVERY_ARCHIVE_LINK_REJECTED');
        result.push(item.name);
      }
    }
  } finally {
    iterator.closeSync();
  }
  return result;
}
export function deliveryArchiveFile(root, id) {
  if (!idPattern.test(id ?? '')) throw fault('DELIVERY_ARCHIVE_ID_INVALID');
  return path.join(root, id.slice(0, 2), id + '.json');
}
export function readArchivedDelivery(root, id, maximumBytes) {
  const file = deliveryArchiveFile(root, id);
  deliveryNoLinks(file);
  const info = fs.statSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.size > maximumBytes) throw fault('DELIVERY_ARCHIVE_INVALID');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw fault('DELIVERY_ARCHIVE_INVALID');
  }
}
/** Write before removing active state. History is addressed by exact ID, so
 * archive size never requires a directory scan or permits old IDs to resend. */
export function archiveDelivery(root, id, value, maximumBytes) {
  const previous = readArchivedDelivery(root, id, maximumBytes),
    raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > maximumBytes) throw fault('DELIVERY_ARCHIVE_INVALID');
  if (previous) {
    if (JSON.stringify(previous) !== raw) throw fault('DELIVERY_ARCHIVE_CONFLICT');
    return;
  }
  const file = deliveryArchiveFile(root, id);
  deliveryNoLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, raw);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    // Use a hard link as an atomic no-replace commit, then unlink the temporary
    // name. Concurrent writers cannot overwrite an existing ID tombstone.
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST' || JSON.stringify(readArchivedDelivery(root, id, maximumBytes)) !== raw)
        throw fault('DELIVERY_ARCHIVE_CONFLICT');
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function deliverySequence(directory, minimum = 0) {
  const file = path.join(directory, 'sequence.json');
  deliveryNoLinks(file);
  const info = fs.statSync(file, { throwIfNoEntry: false });
  let previous = 0;
  if (info) {
    if (!info.isFile() || info.size > 1024) throw fault('DELIVERY_SEQUENCE_INVALID');
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Object.keys(value).length !== 1) throw new Error();
      previous = value.sequence;
    } catch {
      throw fault('DELIVERY_SEQUENCE_INVALID');
    }
  }
  if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(minimum) || minimum < 0)
    throw fault('DELIVERY_SEQUENCE_INVALID');
  const sequence = Math.max(previous, minimum);
  if (sequence !== previous || !info) {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ sequence }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return sequence;
}
