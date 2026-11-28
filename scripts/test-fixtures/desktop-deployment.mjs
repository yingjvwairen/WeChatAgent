import crypto from 'node:crypto';
import releaseProfile from '../../release-profile.json' with { type: 'json' };
const native = 'fixture-desktop-native';
export function desktopManifest(value = {}) {
  return {
    desktopRuntime: true,
    wechatVersion: releaseProfile.wechatVersion,
    bundledWechatVersions: [],
    dshBundled: false,
    readerKey: { bytes: 7, sha256: crypto.createHash('sha256').update('fixture').digest('hex') },
    nativeHashes: { 'WechatQtActions.exe': crypto.createHash('sha256').update(native).digest('hex') },
    ...value,
    files: ['release-profile.json', ...(value.files ?? [])],
  };
}
export function seedDesktopPayloads(write) {
  write('project/release-profile.json', JSON.stringify(releaseProfile));
  for (const file of [
    'runtime/python/python.exe',
    'runtime/ocr/python.exe',
    'runtime/node.exe',
    'runtime/ocr-models/fixture.onnx',
    'runtime/reader-key/wx_key.dll',
  ])
    write(file, 'fixture');
  write('desktop-native/WechatQtActions.exe', native);
}
