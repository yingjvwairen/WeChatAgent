import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { dependencyInstallSpec,prepareUiDependencies } from './prepare-ui-dependencies.mjs';
import { importReaderComponent,readerComponentStatus } from './prepare-reader-component.mjs';
import { KEY_COMPONENT_SHA256 } from './reader-local-setup.mjs';
const component='components/weflow-cli/resources/key/win32/x64/wx_key.dll';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'secondary-prerequisite-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value):value);return file;};return{root,write};}
test('dependency install uses the saved DSH Node with a standalone npm and never Codex or install scripts',async t=>{
  const f=fixture(t),node=f.write('dsh/node/bin/node.exe','fixture-never-run');f.write('state/ui-runtime.json',{schemaVersion:1,node});
  f.write('packages/dsh-social-bridge-plugin/package.json','{}');f.write('packages/dsh-social-bridge-plugin/package-lock.json','{}');
  for(const dir of ['.codex','Codex','custom-agent','standalone'])f.write(dir+'/node_modules/npm/bin/npm-cli.js','fixture-never-run');
  const environment={PATH:['.codex','Codex','custom-agent','standalone'].map(p=>path.join(f.root,p)).join(path.delimiter),CODEX_HOME:path.join(f.root,'custom-agent'),NODE_OPTIONS:'untrusted-fixture',NODE_PATH:'untrusted-fixture'};
  const spec=dependencyInstallSpec({root:f.root,environment});assert.equal(spec.exe,node);assert.equal(spec.args[0],path.join(f.root,'standalone/node_modules/npm/bin/npm-cli.js'));assert(spec.args.includes('--ignore-scripts'));assert(spec.args.includes('ci'));assert.equal(spec.options.shell,false);assert.equal(spec.options.env.CODEX_HOME,undefined);assert.equal(spec.options.env.NODE_OPTIONS,undefined);assert.equal(spec.options.env.PATH.includes('custom-agent'),false);
  let calls=0;const result=await prepareUiDependencies({root:f.root,environment,executeImpl:async(exe,args,options)=>{calls++;assert.equal(exe,node);assert.equal(options.windowsHide,true);return{stdout:'fixture'};}});assert.equal(calls,1);assert.equal(result.installScriptsRun,false);assert.equal(result.servicesStarted,false);
  f.write('dsh/node/node_modules/npm/bin/npm-cli.js','bundled-fixture');assert.equal(dependencyInstallSpec({root:f.root,environment}).args[0],path.join(f.root,'dsh/node/node_modules/npm/bin/npm-cli.js'));
});
test('dependency preparation gives a specific missing-npm failure and refuses active service installation',async t=>{
  const f=fixture(t),node=f.write('dsh/node/bin/node.exe','fixture');f.write('state/ui-runtime.json',{schemaVersion:1,node});
  assert.throws(()=>dependencyInstallSpec({root:f.root,environment:{PATH:''}}),{code:'UI_DEPENDENCY_NPM_REQUIRED'});
  f.write('state/ui-service.lock',{pid:123});await assert.rejects(prepareUiDependencies({root:f.root,executeImpl:async()=>{throw Error('must not execute');}}),{code:'UI_DEPENDENCY_STOP_SERVICES'});
});
test('reader component importer rejects another binary and never overwrites an existing component',t=>{
  const f=fixture(t),source=f.write('installed-WeFlow/resources/key/win32/x64/wx_key.dll','synthetic-wrong-version');
  assert.equal(readerComponentStatus({root:f.root}).ready,false);
  assert.throws(()=>importReaderComponent({root:f.root,source}),{code:'READER_COMPONENT_HASH_MISMATCH'});
  assert.equal(fs.existsSync(path.join(f.root,component)),false);
  assert.throws(()=>importReaderComponent({root:f.root,source:path.join(f.root,'installed-WeFlow')}),{code:'READER_COMPONENT_HASH_MISMATCH'});
});
const reviewed=path.resolve(import.meta.dirname,'..',component);
test('pinned component can be copied into an isolated fixture without loading it; reimport is idempotent',{skip:!fs.existsSync(reviewed)},t=>{
  const f=fixture(t),data=fs.readFileSync(reviewed);assert.equal(crypto.createHash('sha256').update(data).digest('hex'),KEY_COMPONENT_SHA256);
  const source=f.write('source/wx_key.dll',data),result=importReaderComponent({root:f.root,source});assert.equal(result.imported,true);assert.equal(result.loaded,false);assert.equal(result.processAttached,false);assert.equal(readerComponentStatus({root:f.root}).ready,true);
  assert.equal(importReaderComponent({root:f.root,source}).alreadyPresent,true);
  fs.writeFileSync(path.join(f.root,component),'do-not-replace');assert.throws(()=>importReaderComponent({root:f.root,source}),{code:'READER_COMPONENT_HASH_MISMATCH'});assert.equal(fs.readFileSync(path.join(f.root,component),'utf8'),'do-not-replace');
});
