import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const python=path.join(root,'state/ocr/venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
test('visual layout candidates bind real control geometry across width, height, DPI and recording roles', {skip:!fs.existsSync(python)&&'Optional isolated local OCR runtime is not prepared'},()=>{
  const result=spawnSync(python,['-B','-X','utf8',path.join(root,'scripts/test-wechat-layout.py')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.message||'Layout tests failed');
});
