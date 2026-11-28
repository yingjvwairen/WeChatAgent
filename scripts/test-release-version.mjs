import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { launcherAssemblyInfo, releaseIdentity } from './release-version.mjs';

test('the component manifest agrees with the project and desktop release versions', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../components.json', import.meta.url), 'utf8'));
  const project = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const desktop = JSON.parse(fs.readFileSync(new URL('../apps/console-desktop/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, releaseIdentity(project).version);
  assert.equal(
    manifest.components.find(entry => entry.directory === 'apps/console-desktop')?.version,
    releaseIdentity(desktop).version,
  );
});

test('a plus release has an exact public label, valid package alias and numeric Windows build version', () => {
  assert.deepEqual(releaseIdentity({ version: '0.4.1+plus', releaseVersion: '0.4.1+' }), {
    version: '0.4.1+',
    packageVersion: '0.4.1+plus',
    buildVersion: '0.4.1.2',
    tag: 'v0.4.1+',
  });
});
test('normal and existing fix releases retain their release names', () => {
  assert.equal(releaseIdentity({ version: '0.4.1' }).version, '0.4.1');
  assert.equal(releaseIdentity({ version: '0.4.1-fix' }).buildVersion, '0.4.1.1');
});
test('invalid or mismatched labels are rejected before packaging', () => {
  for (const pkg of [
    { version: '0.4.1+' },
    { version: '0.4.1', releaseVersion: '0.4.1+' },
    { version: '0.4.2+plus', releaseVersion: '0.4.1+' },
    { version: '0.4.1+plus' },
    { version: '../0.4.1' },
    { version: '0.4.1', releaseVersion: '0.4.2' },
  ])
    assert.throws(() => releaseIdentity(pkg), /RELEASE_VERSION/);
});

test('the launcher preserves the public label and has a numeric Windows file version', () => {
  for (const [pkg, numeric, label] of [
    [{ version: '0.4.5' }, '0.4.5.0', '0.4.5'],
    [{ version: '0.4.1+plus', releaseVersion: '0.4.1+' }, '0.4.1.2', '0.4.1+'],
    [{ version: '0.4.1-fix' }, '0.4.1.1', '0.4.1-fix'],
  ]) {
    const info = launcherAssemblyInfo(pkg);
    assert.ok(info.includes('AssemblyFileVersion("' + numeric + '")'));
    assert.ok(info.includes('AssemblyInformationalVersion("' + label + '")'));
  }
});
