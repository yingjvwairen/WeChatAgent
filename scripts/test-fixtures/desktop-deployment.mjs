import crypto from 'node:crypto';
const native = 'fixture-desktop-native';
export function desktopManifest(value = {}) {
  return {
    desktopRuntime: true,
    wechatVersion: '4.2.0.53',
    bundledWechatVersions: [],
    dshBundled: false,
    readerKey: { bytes: 7, sha256: crypto.createHash('sha256').update('fixture').digest('hex') },
    nativeHashes: { 'WechatQtActions.exe': crypto.createHash('sha256').update(native).digest('hex') },
    ...value,
  };
}
export function seedDesktopPayloads(write) {
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
