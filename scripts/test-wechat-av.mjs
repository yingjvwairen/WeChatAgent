import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('local audio/video catalog and worker boundary tests',()=>{
  const configured=path.join(root,'state/ui-runtime.json');
  const runtime=fs.existsSync(configured)?JSON.parse(fs.readFileSync(configured,'utf8').replace(/^\uFEFF/,'')):{};
  const python=process.env.WECHATAGENT_TEST_PYTHON||runtime.pythonBase||'python';
  const result=spawnSync(python,['-B',path.join(root,'scripts/test-wechat-av.py')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.message||'Python media tests failed');
});
