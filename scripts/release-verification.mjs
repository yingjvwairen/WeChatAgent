import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

function payloadFiles(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => {
      if (!entry.isFile()) throw Error('INSTALLER_SPECIAL_FILE');
      return path.relative(root, path.join(entry.parentPath, entry.name));
    })
    .sort();
}

async function fileDigest(file) {
  const digest = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(file)) digest.update(block);
  return digest.digest('hex');
}

export async function verifyInstallerPayload(installer, unpacked) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-installer-check-'));
  try {
    // electron-builder stores the x64 application as a 7z archive inside the NSIS executable.
    const { path7za } = createRequire(import.meta.url)('7zip-bin');
    execFileSync(path7za, ['x', '-t7z', '-y', '-bd', '-o' + directory, installer], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 300000,
    });
    const expected = payloadFiles(unpacked);
    if (JSON.stringify(payloadFiles(directory)) !== JSON.stringify(expected))
      throw Error('INSTALLER_PAYLOAD_FILE_SET_CHANGED');
    for (const relative of expected) {
      const [actual, wanted] = await Promise.all(
        [directory, unpacked].map(base => fileDigest(path.join(base, relative))),
      );
      if (actual !== wanted) throw Error('INSTALLER_PAYLOAD_MISMATCH: ' + relative);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

// Preserve the producer's build identity for the console's update comparison.
// checkedAt describes verification time; it must not substitute for builtAt.
export function deploymentVerification(manifest) {
  if (
    !/^[a-f0-9]{16}$/.test(manifest.buildId ?? '') ||
    !Number.isFinite(Date.parse(manifest.builtAt)) ||
    !/^[a-f0-9]{12}$/.test(manifest.runtimeRevision ?? '') ||
    !Array.isArray(manifest.files)
  )
    throw Error('INSTALLER_BUILD_IDENTITY_INVALID');
  return {
    buildId: manifest.buildId,
    builtAt: manifest.builtAt,
    runtimeRevision: manifest.runtimeRevision,
    files: manifest.files.length,
    nativeHashes: manifest.nativeHashes,
  };
}
