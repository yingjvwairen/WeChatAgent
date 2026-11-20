import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readerAccountId} from '../../scripts/reader-account-state.mjs';
import {TargetSelectionStore,validateTargetSelection} from '../../scripts/target-selection.mjs';
import {validSelectionScope} from '../../components/qq-bridge/src/core/selection-scope.js';

const contexts=new AsyncLocalStorage();
const fail=()=>Object.assign(new Error('UI_SELECTION_SCOPE_REVOKED'),{code:'UI_SELECTION_SCOPE_REVOKED',attempted:false});
const wire=value=>String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0)%2147483647n+1n));
function bounded(file) {
  for(let current=path.resolve(file);;current=path.dirname(current)) {
    if(fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())throw fail();
    if(path.dirname(current)===current)break;
  }
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>65536)throw fail();
  return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
/** Management pages and background policies use the same current selection as
 * intake. Per-message grants remain checked separately by withUiSelection. */
export function selectedWechat(root,wechat) {
  const file=path.join(root,'state/reader-service/selection.json');
  if(!fs.lstatSync(file,{throwIfNoEntry:false}))return wechat;
  const denied={...wechat,whitelist:{private:[],groups:[]}};
  try{
    const account=bounded(path.join(root,'state/weflow/active-account.json'));
    const request=bounded(path.join(root,'state/reader/connection-request.json'));
    const current=bounded(path.join(root,'state/weflow/WeFlow-config.json'));
    if(!account.id||request.accountRef!==account.id||readerAccountId(root,current)!==account.id)return denied;
    const selected=validateTargetSelection(bounded(file),account.id);
    const whitelist={private:[],groups:[]};
    for(const target of selected.targets)whitelist[target.wxid.endsWith('@chatroom')?'groups':'private'].push(target.id);
    return {...wechat,whitelist};
  }catch{return denied;}
}
export function verifyUiSelectionScope(root,scope,key) {
  try {
    if(!validSelectionScope(scope)||key!=='wechat:'+(scope.target.endsWith('@chatroom')?'group':'private')+':'+wire(scope.target))return false;
    const prepared=bounded(path.join(root,'state/reader/connection-request.json'));
    const active=bounded(path.join(root,'state/weflow/active-account.json'));
    if(prepared.schemaVersion!==1||prepared.accountRef!==scope.accountRef||active.id!==scope.accountRef)return false;
    const current=bounded(path.join(root,'state/weflow/WeFlow-config.json'));
    if(typeof current.dbPath!=='string'||typeof current.myWxid!=='string'||readerAccountId(root,{dbPath:current.dbPath,myWxid:current.myWxid})!==scope.accountRef)return false;
    // The isolated Reader clears self_wxid overrides and uses this exact
    // scripts/wechat_media.py clean_account_wxid normalization. This verifies
    // the configured database identity, never the desktop login identity.
    if(current.myWxid.trim().replace(/_[A-Za-z0-9]{4}$/u,'')!==scope.account)return false;
    return new TargetSelectionStore({root:path.resolve(root),accountRef:scope.accountRef}).authorizeReplyScope(scope);
  }catch{return false;}
}
export function withUiSelection(root,scope,key,operation) {
  if(scope===undefined)return contexts.run(undefined,operation);
  if(!verifyUiSelectionScope(root,scope,key))throw fail();
  return contexts.run({root:path.resolve(root),scope:Object.freeze(structuredClone(scope)),key},operation);
}
export function assertUiSelectionCurrent() {
  const context=contexts.getStore();
  if(context&&!verifyUiSelectionScope(context.root,context.scope,context.key))throw fail();
}
/** undefined means legacy policy; false must NOT fall back to legacy allowlist. */
export function uiSelectionDecision(key) {
  const context=contexts.getStore();
  return context?key===context.key&&verifyUiSelectionScope(context.root,context.scope,key):undefined;
}
