export const FILE_LIMIT = 50 * 1024 * 1024;
export const fileId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const safeFileName = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.isWellFormed() &&
  value.length <= 255 &&
  [...value].length <= 180 &&
  !/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) &&
  !/[. ]$/.test(value) &&
  !/^\.{1,2}$/.test(value) &&
  !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
export const validFileReference = file =>
  fileId(file?.id) &&
  safeFileName(file.name) &&
  Number.isSafeInteger(file.size) &&
  file.size >= 0 &&
  file.size <= FILE_LIMIT;
