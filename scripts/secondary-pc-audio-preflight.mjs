// Read-only deployment audit. Never opens an audio stream, changes a default,
// reads OBS service credentials, controls WeChat, or claims stream isolation.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value);
const roles = ['console', 'multimedia', 'communications'];
const cable = device => object(device) && device.adapter === 'VB-Audio Virtual Cable' &&
  device.name === (device.flow === 'render' ? 'CABLE Input (VB-Audio Virtual Cable)' : device.flow === 'capture' ? 'CABLE Output (VB-Audio Virtual Cable)' : null);
function device(value) {
  if (!object(value) || !bounded(value.id) || !bounded(value.name) || !bounded(value.adapter) || !['render', 'capture'].includes(value.flow)) throw fault('SECONDARY_AUDIO_METADATA_INVALID');
  return value;
}
function defaults(value, flow, devices) {
  return Object.fromEntries(roles.map(role => {
    const row = value?.[role]; if (row === undefined) return [role, 'unreported'];
    if (!object(row) || typeof row.available !== 'boolean') throw fault('SECONDARY_AUDIO_METADATA_INVALID');
    if (!row.available) return [role, 'unavailable'];
    const selected = device(row.device);
    if (selected.flow !== flow || !devices.some(item => item.id === selected.id && item.flow === flow)) throw fault('SECONDARY_AUDIO_METADATA_INVALID');
    return [role, cable(selected) ? 'cable' : 'other'];
  }));
}

/** Counts configuration risks without returning device IDs, source names or settings. */
export function analyzeSecondaryPcAudio({ audioSnapshot, obsSceneCollection } = {}) {
  if (!object(audioSnapshot) || audioSnapshot.ok !== true || audioSnapshot.mode !== 'list' || audioSnapshot.audioStarted !== false || audioSnapshot.recordingSaved !== false ||
      audioSnapshot.defaultsUsedForAudio !== false || !Array.isArray(audioSnapshot.devices) || audioSnapshot.devices.length > 256) throw fault('SECONDARY_AUDIO_METADATA_INVALID');
  const devices = audioSnapshot.devices.map(device), renders = devices.filter(item => item.flow === 'render' && cable(item)), captures = devices.filter(item => item.flow === 'capture' && cable(item));
  const uniquePair = renders.length === 1 && captures.length === 1 && renders[0].id !== captures[0].id;
  const captureDefaults = defaults(audioSnapshot.defaultCapture, 'capture', devices), renderDefaults = defaults(audioSnapshot.defaultRender, 'render', devices);
  const cableIds = new Set([...renders, ...captures].map(item => item.id));
  const risks = [];
  if (!uniquePair) risks.push('CABLE_PAIR_MISSING_OR_AMBIGUOUS');
  if ([...Object.values(captureDefaults), ...Object.values(renderDefaults)].includes('unreported')) risks.push('AUDIO_PROBE_METADATA_INCOMPLETE');
  if (Object.values(captureDefaults).some(value => value !== 'cable')) risks.push('WECHAT_REQUIRED_CAPTURE_DEFAULTS_NOT_CABLE');
  if (Object.values(renderDefaults).some(value => value === 'cable')) risks.push('SYSTEM_OUTPUT_DEFAULT_POINTS_TO_CABLE');
  let obs = { supplied: false, configurationOnly: true, liveMixerVerified: false };
  if (obsSceneCollection === undefined) risks.push('OBS_SCENE_COLLECTION_NOT_SUPPLIED');
  else {
    if (!object(obsSceneCollection) || !Array.isArray(obsSceneCollection.sources) || obsSceneCollection.sources.length > 10000) throw fault('SECONDARY_OBS_SCENE_INVALID');
    const sources = [...obsSceneCollection.sources];
    for (const key of ['DesktopAudioDevice1', 'DesktopAudioDevice2', 'AuxAudioDevice1', 'AuxAudioDevice2', 'AuxAudioDevice3', 'AuxAudioDevice4']) if (object(obsSceneCollection[key])) sources.push(obsSceneCollection[key]);
    const counts = { configuredInputSources: 0, defaultInputSources: 0, explicitInputSources: 0, configuredOutputSources: 0, defaultOutputSources: 0,
      cableCaptureSources: 0, applicationAudioSources: 0, monitoringEnabledSources: 0, otherSourceTypesNotAssessed: 0 };
    for (const source of sources) {
      if (!object(source)) throw fault('SECONDARY_OBS_SCENE_INVALID');
      const type = source.id ?? source.versioned_id;
      if (typeof type !== 'string' || type.length > 128) throw fault('SECONDARY_OBS_SCENE_INVALID');
      const settings = object(source.settings) ? source.settings : {};
      if (Number.isInteger(source.monitoring_type) && source.monitoring_type > 0) counts.monitoringEnabledSources++;
      if (type === 'wasapi_input_capture' || type === 'wasapi_output_capture') {
        const selected = settings.device_id;
        if (selected !== undefined && selected !== '' && !bounded(selected)) throw fault('SECONDARY_OBS_SCENE_INVALID');
        const followsDefault = selected === undefined || selected === '' || selected.toLowerCase() === 'default';
        if (type === 'wasapi_input_capture') { counts.configuredInputSources++; if (followsDefault) counts.defaultInputSources++; else counts.explicitInputSources++; }
        else { counts.configuredOutputSources++; if (followsDefault) counts.defaultOutputSources++; }
        if (typeof selected === 'string' && cableIds.has(selected)) counts.cableCaptureSources++;
      } else if (type === 'wasapi_process_output_capture') counts.applicationAudioSources++;
      else counts.otherSourceTypesNotAssessed++;
    }
    obs = { ...obs, supplied: true, ...counts };
    if (counts.defaultInputSources) risks.push('OBS_MIC_FOLLOWS_WINDOWS_DEFAULT');
    if (counts.cableCaptureSources) risks.push('OBS_CAPTURES_BOT_CABLE');
    if (counts.defaultOutputSources && renderDefaults.console === 'cable') risks.push('OBS_DESKTOP_AUDIO_CAPTURES_DEFAULT_CABLE');
    if (counts.monitoringEnabledSources) risks.push('OBS_MONITORING_ROUTE_REQUIRES_REVIEW');
    if (counts.applicationAudioSources || counts.otherSourceTypesNotAssessed) risks.push('OBS_OTHER_AUDIO_PATHS_NOT_VERIFIED');
  }
  return { ok: true, readOnly: true, cable: { renderCount: renders.length, captureCount: captures.length, uniquePair },
    captureDefaults, renderDefaults, obs, risks, captureDefaultsMatchVoiceRequirement: uniquePair && Object.values(captureDefaults).every(value => value === 'cable'),
    wechatCaptureSourceVerified: false, streamIsolationVerified: false, windowsListenRoutingVerified: false, readyForUnattendedSending: false,
    inputSent: false, audioStarted: false, captureOpened: false, settingsChanged: false };
}

function noLinks(file) {
  for (let current = path.resolve(file);;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('SECONDARY_PREFLIGHT_LINK_REJECTED');
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
function jsonFile(file, limit) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^(?:\\\\|\/\/)/.test(file) || path.extname(file).toLowerCase() !== '.json' || /^service\.json$/i.test(path.basename(file))) throw fault('SECONDARY_PREFLIGHT_PATH_INVALID');
  noLinks(file); const info = fs.statSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size > limit) throw fault('SECONDARY_PREFLIGHT_FILE_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw fault('SECONDARY_PREFLIGHT_JSON_INVALID'); }
}

export async function secondaryPcAudioPreflight({ root = projectRoot, audioReportFile, obsSceneFile, executeImpl = execute } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /^(?:\\\\|\/\/)/.test(root)) throw fault('SECONDARY_PREFLIGHT_PATH_INVALID');
  noLinks(root);
  let audioSnapshot;
  if (audioReportFile !== undefined) audioSnapshot = jsonFile(audioReportFile, 256 * 1024);
  else {
    const executable = path.resolve(root, 'state/audio-probe/AudioRouteProbe.exe'); noLinks(executable);
    if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw fault('SECONDARY_AUDIO_PROBE_MISSING');
    try {
      const result = await executeImpl(executable, ['--list'], { cwd: root, windowsHide: true, shell: false, timeout: 15000, maxBuffer: 256 * 1024 });
      audioSnapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    } catch { throw fault('SECONDARY_AUDIO_METADATA_FAILED'); }
  }
  const obsSceneCollection = obsSceneFile === undefined ? undefined : jsonFile(obsSceneFile, 16 * 1024 * 1024);
  return analyzeSecondaryPcAudio({ audioSnapshot, obsSceneCollection });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1];
      if (!value || !['--audio-report', '--obs-scenes'].includes(key)) throw fault('SECONDARY_PREFLIGHT_ARGUMENTS_INVALID');
      const field = key === '--audio-report' ? 'audioReportFile' : 'obsSceneFile';
      if (options[field] !== undefined) throw fault('SECONDARY_PREFLIGHT_ARGUMENTS_INVALID'); options[field] = value;
    }
    console.log(JSON.stringify(await secondaryPcAudioPreflight(options)));
  } catch (error) { console.log(JSON.stringify({ ok: false, code: /^SECONDARY_[A-Z_]+$/.test(error?.code) ? error.code : 'SECONDARY_PREFLIGHT_FAILED', inputSent: false, audioStarted: false, captureOpened: false, settingsChanged: false })); process.exitCode = 1; }
}
