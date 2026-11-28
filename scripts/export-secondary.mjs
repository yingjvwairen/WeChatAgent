import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { withReleaseSnapshot } from './release-snapshot.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: { output: { type: 'string' }, help: { type: 'boolean' }, 'working-tree': { type: 'boolean' } },
});
if (values.help) {
  console.log('node scripts/export-secondary.mjs [--working-tree] [--output <new.zip>]');
} else {
  const workingTree = values['working-tree'] === true;
  await withReleaseSnapshot(
    root,
    ({ archive, commit }) => {
      const output = path.resolve(
        values.output ??
          path.join(
            root,
            'release',
            'WeChatAgent-source-' + commit.slice(0, 12) + (workingTree ? '-working-tree.zip' : '.zip'),
          ),
      );
      if (path.extname(output).toLowerCase() !== '.zip' || fs.existsSync(output))
        throw Error('请选择一个尚不存在的 .zip 文件。');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(archive, output, fs.constants.COPYFILE_EXCL);
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
      console.log(JSON.stringify({ file: output, commit, ...(workingTree ? { workingTree } : {}), sha256 }, null, 2));
    },
    { workingTree },
  );
}
