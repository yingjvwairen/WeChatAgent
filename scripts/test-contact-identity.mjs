import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { contactIdentity } from './contact-identity.mjs';

const protectedKey = 'userdpapi:' + Buffer.concat([Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex'), Buffer.alloc(40)]).toString('base64');
const accountRef = 'a'.repeat(64);
const worker = `
let raw=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk=>raw+=chunk);
process.stdin.on('end',()=>{
 const r=JSON.parse(raw), mode=process.env.FIXTURE_MODE;
 if(mode==='silent'){setTimeout(()=>process.exit(0),60000);return;}
 if(mode==='malformed'){console.log(r.protectedKey+' PRIVATE CONTACT');return;}
 let result = r.query.operation==='inspect' ? {
  schema:{table:'contact',columns:['username','alias','delete_flag']},
  counts:{contacts:3,nonemptyAliases:2,supportedAliases:2,uniqueEligibleAliases:2,ambiguousAliasGroups:0},
  anonymousChecks:{exactRoundTrips:2,allPassed:true},
  filehelper:{canonicalRows:1,aliasPresent:false,independentBuiltinMarkerVerified:false,displayNameIsIdentity:false},
  privateUnexpected:'SHOULD NEVER LEAK'
 } : {matched:true,source:r.query.operation==='verify-id'?'contact.username':'contact.alias',comparison:'exact',unique:true,...(r.query.operation==='lookup'?{username:'wxid_private_fixture'}:{})};
 console.error('PRIVATE STDERR '+r.protectedKey);
 const packet={ok:true,version:1,operation:r.query.operation,accountRef:mode==='wrong-account'?'b'.repeat(64):r.accountRef,result,
 readOnly:true,networkStarted:false,keyComponentLoaded:false,desktopAccountVerified:false,targetOnScreenVerified:false,observedAt:Date.now()};
 console.log(JSON.stringify(packet)); if(mode==='duplicate')console.log(JSON.stringify(packet));
});`;

function fixture(t, mode='') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'contact-identity-test-'));
  const file=path.join(root,'worker.mjs'); fs.writeFileSync(file,worker);
  const binding={account:{accountRef,dbPath:path.join(root,'private-account'),myWxid:'private-account'},python:'fixture-python',cached:{schemaVersion:1,accountRef,protectedKey,savedAt:new Date().toISOString()}};
  let starts=0;
  t.after(()=>{const target=fs.realpathSync(root);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.match(path.basename(target),/^contact-identity-test-/);fs.rmSync(target,{recursive:true,force:true});});
  const spawnImpl=(executable,args,options)=>{
    starts++;assert.equal(executable,'fixture-python');assert.deepEqual(args,['-I','-B',path.join(root,'scripts/contact-identity.py')]);
    assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
    assert.equal(Object.keys(options.env).some(k=>['PYTHONPATH','PYTHONHOME'].includes(k.toUpperCase())),false);
    assert.equal(JSON.stringify(args).includes(protectedKey),false);
    return spawn(process.execPath,[file],{...options,env:{...options.env,FIXTURE_MODE:mode}});
  };
  return {root,binding,spawnImpl,check:()=>binding,starts:()=>starts};
}

test('inspect returns only anonymous fields; protected credentials stay on private stdin',async t=>{
  const f=fixture(t);const result=await contactIdentity(f);
  assert.equal(result.anonymousChecks.allPassed,true);assert.equal(result.processStopped,true);assert.equal(result.desktopAccountVerified,false);
  for(const value of [protectedKey,'private-account','SHOULD NEVER LEAK','PRIVATE STDERR',accountRef]) assert.equal(JSON.stringify(result).includes(value),false);
  assert.equal(f.starts(),1);
});

test('lookup is private programmatic data and verify returns only exact match evidence',async t=>{
  const f=fixture(t);
  const lookup=await contactIdentity({...f,expectedAccountRef:accountRef,query:{operation:'lookup',alias:'Public_ID'}});
  assert.equal(lookup.username,'wxid_private_fixture');assert.equal(lookup.targetOnScreenVerified,false);
  assert.equal(lookup.accountRef,accountRef);
  const verify=await contactIdentity({...f,expectedAccountRef:accountRef,query:{operation:'verify',alias:'Public_ID',expectedUsername:'wxid_private_fixture'}});
  assert.equal(verify.matched,true);assert.equal(Object.hasOwn(verify,'username'),false);
});
test('explicit profile username verification is bound to account and returns no identity payload',async t=>{
  const f=fixture(t);const result=await contactIdentity({...f,expectedAccountRef:accountRef,query:{operation:'verify-id',displayedId:'wxid_private_fixture',expectedUsername:'wxid_private_fixture'}});
  assert.equal(result.matched,true);assert.equal(result.source,'contact.username');assert.equal(Object.hasOwn(result,'username'),false);
});

test('invalid input, missing credential and pre-cancelled calls never start Python',async t=>{
  const f=fixture(t);const controller=new AbortController();controller.abort();
  await assert.rejects(contactIdentity({...f,signal:controller.signal}),{code:'CONTACT_IDENTITY_CANCELLED'});
  await assert.rejects(contactIdentity({...f,query:{operation:'lookup',alias:' Value '}}),{code:'CONTACT_IDENTITY_DISPLAY_ID_INVALID'});
  await assert.rejects(contactIdentity({...f,query:{operation:'lookup',alias:'Public_ID'}}),{code:'CONTACT_IDENTITY_ACCOUNT_SCOPE_REQUIRED'});
  await assert.rejects(contactIdentity({...f,expectedAccountRef:'b'.repeat(64),query:{operation:'lookup',alias:'Public_ID'}}),{code:'CONTACT_IDENTITY_ACCOUNT_MISMATCH'});
  await assert.rejects(contactIdentity({...f,check:()=>({...f.binding,cached:null})}),{code:'CONTACT_IDENTITY_CREDENTIAL_REQUIRED'});
  assert.equal(f.starts(),0);
});

test('malformed, duplicate and wrong-account child packets produce only safe errors',async t=>{
  for(const mode of ['malformed','duplicate','wrong-account']){
    const f=fixture(t,mode);
    await assert.rejects(contactIdentity(f),error=>error.code==='CONTACT_IDENTITY_PROTOCOL_INVALID' && error.message===error.code);
  }
});

test('account changes after the read discard a successful child result',async t=>{
  const f=fixture(t);let checks=0;
  await assert.rejects(contactIdentity({...f,check:()=>++checks===1?f.binding:{...f.binding,account:{...f.binding.account,accountRef:'b'.repeat(64)}}}),{code:'CONTACT_IDENTITY_BINDING_CHANGED'});
});

test('active cancellation stops the isolated mock child',async t=>{
  const f=fixture(t,'silent'),controller=new AbortController();
  const pending=contactIdentity({...f,signal:controller.signal});
  setTimeout(()=>controller.abort(),50);
  await assert.rejects(pending,{code:'CONTACT_IDENTITY_CANCELLED'});
});

test('Python SQLite identity tests use memory fixtures only',t=>{
  const python=path.resolve(import.meta.dirname,'../state/reader/venv/Scripts/python.exe');
  if(!fs.existsSync(python)){t.skip('Reader Python unavailable');return;}
  const result=spawnSync(python,['-I','-B',path.join(import.meta.dirname,'test-contact-identity.py')],{windowsHide:true,timeout:5000,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
