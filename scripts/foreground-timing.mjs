import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const phases = ['contact-navigation', 'preparation', 'record-start', 'record-submit', 'record-cancel'];
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const duration = value => Number.isSafeInteger(value) && value >= 0 && value <= 120000;

/** Anonymous diagnostics only. Invalid or legacy measurements are unavailable,
 * never a reason to retry input or change a delivery/cleanup outcome. */
export function sanitizeForegroundIntervals(value, { phases: allowed = phases, maxCount = 32 } = {}) {
  if (!Array.isArray(value) || value.length > maxCount || value.some(item =>
    !exact(item, ['phase', 'durationMs', 'includesContactNavigation', 'complete']) || !allowed.includes(item.phase) ||
    !duration(item.durationMs) || typeof item.includesContactNavigation !== 'boolean' || typeof item.complete !== 'boolean')) return undefined;
  return value.map(item => ({ phase: item.phase, durationMs: item.durationMs,
    includesContactNavigation: item.includesContactNavigation, complete: item.complete }));
}

export function makeForegroundTiming({ operation, preparationIntervals, nativeIntervals } = {}) {
  if (!['text', 'voice'].includes(operation)) return undefined;
  const preparation = preparationIntervals === undefined ? [] : sanitizeForegroundIntervals(preparationIntervals, { phases: phases.slice(0, 2), maxCount: 30 });
  const native = nativeIntervals === undefined ? [] : sanitizeForegroundIntervals(nativeIntervals, { phases: phases.slice(2), maxCount: 3 });
  if (!preparation || !native || operation === 'text' && native.length) return undefined;
  if (native.length && (new Set(native.map(item => item.phase)).size !== native.length || native.some((item,index)=>index>0&&phases.indexOf(item.phase)<=phases.indexOf(native[index-1].phase)))) return undefined;
  const intervals = [...preparation, ...native];
  if (!intervals.length) return undefined;
  const complete = intervals.every(item => item.complete) && (operation === 'text' || native.length === 2 && native[0].phase === 'record-start' && native[1].phase === 'record-submit');
  return { version: 1, operation, intervals, complete,
    includesContactNavigation: intervals.some(item => item.includesContactNavigation),
    maxContinuousForegroundMs: complete ? Math.max(...intervals.map(item => item.durationMs)) : null };
}

export function sanitizeForegroundTiming(value) {
  if (!exact(value, ['version', 'operation', 'intervals', 'complete', 'includesContactNavigation', 'maxContinuousForegroundMs']) || value.version !== 1) return undefined;
  const intervals = sanitizeForegroundIntervals(value.intervals);
  if (!intervals) return undefined;
  const boundary = intervals.findIndex(item => phases.slice(2).includes(item.phase));
  const expected = makeForegroundTiming({ operation: value.operation,
    preparationIntervals: boundary < 0 ? intervals : intervals.slice(0, boundary), nativeIntervals: boundary < 0 ? [] : intervals.slice(boundary) });
  if (!expected || ['complete', 'includesContactNavigation', 'maxContinuousForegroundMs'].some(key => expected[key] !== value[key])) return undefined;
  return expected;
}

function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('FOREGROUND_TIMING_LINK_REJECTED');
    if (path.dirname(item) === item) return;
  }
}
const directoryFor = root => path.join(root, 'state', 'foreground-timing');

export function recordForegroundTiming({ root, timing, now = Date.now } = {}) {
  const safe = sanitizeForegroundTiming(timing);
  if (!safe || typeof root !== 'string' || typeof now !== 'function') return false;
  let temporary;
  try {
    const measuredAt = now();
    if (!Number.isSafeInteger(measuredAt) || measuredAt < 1) return false;
    const directory = directoryFor(root); noLinks(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `latest-${safe.operation}.json`); noLinks(file);
    temporary = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ measuredAt, ...safe }), { flag: 'wx', mode: 0o600 });
    noLinks(file); fs.renameSync(temporary, file); temporary = undefined; return true;
  } catch { return false; }
  finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
}

export function readForegroundTimings({ root } = {}) {
  const measurements = [];
  if (typeof root !== 'string') return { available: false, measurements };
  for (const operation of ['text', 'voice']) {
    try {
      const file = path.join(directoryFor(root), `latest-${operation}.json`); noLinks(file);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size > 16384) continue;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!object(value)) continue;
      const { measuredAt, ...body } = value, timing = sanitizeForegroundTiming(body);
      if (!timing || timing.operation !== operation || !Number.isSafeInteger(measuredAt) || measuredAt < 1) continue;
      measurements.push({ measuredAt, ...timing });
    } catch {}
  }
  return { available: measurements.length > 0, measurements };
}
