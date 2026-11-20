import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),python=path.join(root,'state/ocr/venv/Scripts/python.exe');
test('search popup geometry proves all four edges and corners without assuming shadow margins',{skip:!fs.existsSync(python)},()=>{
  const result=spawnSync(python,['-I','-B',path.join(root,'scripts/test-qt-search-popup.py')],{windowsHide:true,shell:false,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
});
