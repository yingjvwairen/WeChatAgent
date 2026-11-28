import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { qualityBase, sourceQualityFiles } from './source-quality-files.mjs';

test('quality scope needs a real baseline and checks the whole change after a shallow fetch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-quality-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true });
  git('init', '-q');
  const commit = message => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
  };
  fs.writeFileSync(path.join(root, 'bridge.mjs'), 'export {}\n');
  commit('release');
  if (process.env.WECHATAGENT_QUALITY_BASE) t.skip('A caller-supplied base overrides the default');
  else {
    assert.throws(() => qualityBase(root), /QUALITY_BASE_UNAVAILABLE/);
    git('tag', 'v0.4.5');
    const release = git('rev-parse', 'HEAD').toString().trim();
    fs.writeFileSync(path.join(root, 'bridge.mjs'), 'export const example = 1;\n');
    commit('change');
    fs.writeFileSync(path.join(root, 'reader.py'), 'ready = True\n');
    commit('reader');
    assert.equal(qualityBase(root), 'v0.4.5');
    assert.deepEqual(sourceQualityFiles(root), ['bridge.mjs', 'reader.py']);
    assert.deepEqual(sourceQualityFiles(root, 'HEAD'), []);
    const shallow = path.join(root, 'shallow');
    git('clone', '-q', '--no-tags', '--depth=1', pathToFileURL(root).href, shallow);
    assert.throws(() => sourceQualityFiles(shallow), /QUALITY_BASE_UNAVAILABLE/);
    git('-C', shallow, 'fetch', '-q', '--depth=1', 'origin', release);
    assert.deepEqual(sourceQualityFiles(shallow, release), ['bridge.mjs', 'reader.py']);
  }
});

test('source build and secondary export use the same commit despite staged, edited and untracked files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const cli = (program, args) => execFileSync(program, args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
  const git = (...args) => cli('git', args);
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['release-snapshot', 'release-version', 'build-source-release', 'export-secondary'])
    fs.copyFileSync(path.join(import.meta.dirname, name + '.mjs'), path.join(root, 'scripts', name + '.mjs'));
  // The real repo supplies the source auditor. This tiny package exercises the two packaging CLIs.
  fs.writeFileSync(
    path.join(root, 'scripts/public-source-check.mjs'),
    `import {execFileSync} from 'node:child_process';
    const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\\0').filter(Boolean).sort();
    console.log(JSON.stringify({files,findings:[],pluginHost:{revision:'test'}}));`,
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.5' }));
  fs.writeFileSync(path.join(root, '.gitignore'), '/state/\n/release/\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed\n');
  fs.writeFileSync(path.join(root, 'removed.txt'), 'committed\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source');
  const build = () => JSON.parse(cli(process.execPath, ['scripts/build-source-release.mjs']));
  const first = build();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged\n');
  git('add', 'tracked.txt');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'working tree\n');
  fs.writeFileSync(path.join(root, 'local-note.txt'), 'untracked');
  assert.deepEqual(build(), first);
  const other = JSON.parse(
    cli(process.execPath, ['scripts/export-secondary.mjs', '--output', 'release/secondary.zip']),
  );
  assert.equal(first.commit, git('rev-parse', 'HEAD'));
  assert.equal(other.sha256, first.sha256);
  assert.deepEqual(fs.readFileSync(other.file), fs.readFileSync(first.output));
  const report = JSON.parse(fs.readFileSync(path.join(root, 'state/source-release-0.4.5.json')));
  assert.equal(report.commit, other.commit);
  assert.equal(report.sourceFiles['local-note.txt'], undefined);

  fs.unlinkSync(path.join(root, 'removed.txt'));
  fs.writeFileSync(path.join(root, 'state/private.txt'), 'ignored data');
  const pending = git('status', '--porcelain=v1');
  const local = JSON.parse(cli(process.execPath, ['scripts/export-secondary.mjs', '--working-tree']));
  assert.equal(local.commit, first.commit);
  assert.equal(local.workingTree, true);
  assert.notEqual(local.sha256, first.sha256);
  const names = cli('tar', ['-tf', local.file]).split(/\r?\n/);
  assert(names.includes('local-note.txt'));
  assert(!names.includes('removed.txt'));
  assert(!names.some(name => name.startsWith('state/')));
  assert.equal(cli('tar', ['-xOf', local.file, 'tracked.txt']), 'working tree');
  assert.equal(git('status', '--porcelain=v1'), pending);
});
