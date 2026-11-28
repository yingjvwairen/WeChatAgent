const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const code = value => value === null || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,90}$/.test(value));
const exact = (value, keys) =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** Format metadata only. No clipboard payload, hash, URL value or owner id. */
export function clipboardBackupDiagnostic(value) {
  const fields = [
    'version',
    'phase',
    'stage',
    'failure',
    'total',
    'truncated',
    'sequenceBefore',
    'sequenceAfter',
    'ownerStable',
    'complete',
    'formats',
    'payloadIncluded',
    'clipboardModified',
  ];
  if (
    !exact(value, fields) ||
    value.version !== 1 ||
    !['original', 'restore'].includes(value.phase) ||
    !['open', 'enumerate', 'read', 'verify', 'complete'].includes(value.stage) ||
    !code(value.failure) ||
    !Number.isInteger(value.total) ||
    value.total < -1 ||
    value.total > 65536 ||
    !['truncated', 'ownerStable', 'complete'].every(k => typeof value[k] === 'boolean') ||
    !['sequenceBefore', 'sequenceAfter'].every(
      k => Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 0xffffffff,
    ) ||
    value.payloadIncluded !== false ||
    value.clipboardModified !== false ||
    !Array.isArray(value.formats) ||
    value.formats.length > 64
  )
    return undefined;
  for (const row of value.formats) {
    if (
      !exact(row, ['id', 'registeredName', 'backupSupported', 'storage', 'byteLength', 'state', 'error']) ||
      !Number.isInteger(row.id) ||
      row.id < 1 ||
      row.id > 65535 ||
      typeof row.backupSupported !== 'boolean' ||
      !['hglobal', 'synthesized-bitmap', 'unsupported'].includes(row.storage) ||
      !['offered', 'companion', 'omitted', 'unsupported', 'read', 'copied', 'unavailable'].includes(row.state) ||
      !code(row.error) ||
      (row.byteLength !== null && (!Number.isSafeInteger(row.byteLength) || row.byteLength < 0)) ||
      (row.registeredName !== null &&
        (typeof row.registeredName !== 'string' ||
          row.registeredName.length > 256 ||
          /[\x00-\x1f\x7f]/.test(row.registeredName)))
    )
      return undefined;
  }
  return structuredClone(value);
}
export const clipboardBackupRefusal = reason =>
  [
    'DRAFT_CLIPBOARD_COMPLEX_FORMAT',
    'DRAFT_CLIPBOARD_DATA_TOO_LARGE',
    'DRAFT_CLIPBOARD_DATA_UNAVAILABLE',
    'DRAFT_CLIPBOARD_FORMAT_INVALID',
  ].includes(reason);
export function clipboardRestorationDiagnostic(value) {
  const fields = [
    'version',
    'lossless',
    'formatCount',
    'byteLength',
    'restoredFormatCount',
    'restoredByteLength',
    'exactPayloadMatched',
    'formatOrderMatched',
    'formats',
  ];
  if (
    !exact(value, fields) ||
    value.version !== 1 ||
    !['lossless', 'exactPayloadMatched', 'formatOrderMatched'].every(k => typeof value[k] === 'boolean') ||
    !['formatCount', 'restoredFormatCount'].every(k => Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 32) ||
    !['byteLength', 'restoredByteLength'].every(
      k => Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 64 * 1024 * 1024,
    ) ||
    !Array.isArray(value.formats) ||
    value.formats.length !== value.formatCount
  )
    return undefined;
  for (const row of value.formats)
    if (
      !exact(row, ['id', 'byteLength', 'restoredByteLength', 'exactMatched']) ||
      !Number.isInteger(row.id) ||
      row.id < 1 ||
      row.id > 65535 ||
      typeof row.exactMatched !== 'boolean' ||
      !Number.isInteger(row.byteLength) ||
      row.byteLength < 0 ||
      row.byteLength > 32 * 1024 * 1024 ||
      (row.restoredByteLength !== null &&
        (!Number.isInteger(row.restoredByteLength) ||
          row.restoredByteLength < 0 ||
          row.restoredByteLength > 32 * 1024 * 1024))
    )
      return undefined;
  return structuredClone(value);
}
