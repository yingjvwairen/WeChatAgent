import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function captureWorkingTree(workspace, temporary, git, env) {
  const captured = path.join(temporary, 'captured'),
    gitDir = path.join(temporary, 'capture.git');
  fs.mkdirSync(captured);
  for (const relative of new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0'))) {
    if (!relative) continue;
    const source = path.join(workspace, relative);
    for (let at = source; at !== workspace; at = path.dirname(at)) {
      if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('SOURCE_EXPORT_LINK');
    }
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!stat) continue; // A removed tracked file is absent from the working snapshot.
    if (!stat.isFile()) throw Error('SOURCE_EXPORT_SPECIAL_FILE');
    if (stat.size > 100 * 1024 * 1024) throw Error('SOURCE_EXPORT_FILE_LIMIT');
    const target = path.join(captured, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  execFileSync('git', ['init', '--bare', '--quiet', gitDir], { cwd: temporary, env, windowsHide: true });
  const scope = { GIT_DIR: gitDir, GIT_WORK_TREE: captured, GIT_INDEX_FILE: path.join(temporary, 'capture.index') };
  const write = args => git(args, captured, { ...env, ...scope });
  write(['-c', 'core.autocrlf=false', 'add', '--force', '--all', '--', '.']);
  return { gitDir, tree: write(['write-tree']).trim() };
}

/** Build from an audited commit, or explicitly capture local changes for a secondary PC. */
export async function withReleaseSnapshot(workspace, build, { workingTree = false } = {}) {
  workspace = path.resolve(workspace);
  const env = { ...process.env, TZ: 'UTC' };
  const git = (args, cwd = workspace, environment = env) =>
    execFileSync('git', args, {
      cwd,
      env: environment,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-release-'));
  try {
    const archive = path.join(temporary, 'source.zip'),
      directory = path.join(temporary, 'source');
    fs.mkdirSync(directory);
    const source = workingTree
      ? captureWorkingTree(workspace, temporary, git, env)
      : { gitDir: git(['rev-parse', '--absolute-git-dir']).trim(), tree: commit };
    const auditEnv = {
      ...env,
      GIT_DIR: source.gitDir,
      GIT_WORK_TREE: directory,
      GIT_INDEX_FILE: path.join(temporary, 'index'),
    };
    git(
      ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', '--output', archive, source.tree],
      directory,
      auditEnv,
    );
    execFileSync('tar', ['-xf', archive, '-C', directory], { windowsHide: true });
    const options = { cwd: directory, env: auditEnv, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
    execFileSync('git', ['read-tree', source.tree], options);
    const audit = JSON.parse(execFileSync(process.execPath, ['scripts/public-source-check.mjs', '--files'], options));
    if (audit.findings.length) throw Error('SOURCE_RELEASE_CHECK_FAILED');
    return await build({ commit, directory, archive, files: audit.files, pluginHost: audit.pluginHost });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
