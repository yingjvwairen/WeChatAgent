import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pluginConfigUi} from './plugin-config-ui.mjs';
import {pluginSettingsMarkup} from '../public/console/plugin-config-ui.mjs';
import {pluginCatalog,updatePlugin} from '../packages/plugin-api/catalog.mjs';

test('installed form uses the current package schema, falls back on invalid fields and rejects stale saves',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-plugin-form-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'plugins','chat-notes');
  fs.cpSync(path.join(import.meta.dirname,'../examples/plugins/chat-notes'),dir,{recursive:true});
  const catalog=pluginCatalog(root);
  const item=catalog.plugins[0];
  Object.assign(item,pluginConfigUi(root,item));
  assert.equal(item.configUi.sections[0].fields[0],'maxNotes');
  assert.match(pluginSettingsMarkup(item,[{key:'maxNotes',html:'<input>'}],x=>x),/便签保存/);
  fs.writeFileSync(path.join(dir,'config-ui.json'),JSON.stringify({version:1,sections:[{id:'a',title:'a',fields:['missing']}]}));
  const changed=pluginConfigUi(root,item);
  assert.ok(changed.configUiError);
  assert.match(pluginSettingsMarkup(changed,[{key:'maxNotes',html:'<input>'}],x=>x),/<input>/);
  assert.throws(()=>updatePlugin(root,item.id,{revision:catalog.revision,packageRevision:item.revision}),{status:409});
});
