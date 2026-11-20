import test from 'node:test';
import assert from 'node:assert/strict';
import {createStickerManagerUI,parseStickerTags,validateStickerFile} from '../public/console/sticker-manager.js';
import {createReplyMediaUI} from '../public/console/reply-media.js';

const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const snapshot=()=>({version:1,revision:'a'.repeat(64),enabled:true,items:[{id:'b'.repeat(64),sha256:'b'.repeat(64),name:'原名',path:'D:/fixtures/原图.png',kind:'image',tags:['开心']}]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function mediaFixture() {
  const nodes=new Map(),calls=[],toasts=[],handlers=new Map(),saved=snapshot();
  const query=selector=>{
    if(!nodes.has(selector)){
      const element={id:selector.slice(1),isConnected:true,dataset:{},disabled:false,addEventListener(name,fn){this.listeners[name]=fn;},listeners:{},closest(){return this;}};
      Object.defineProperty(element,'outerHTML',{set(value){this.html=value;this.listeners={};},get(){return this.html;}});
      nodes.set(selector,element);
    }
    return nodes.get(selector);
  };
  const api=async(route,body)=>{calls.push({route,body});if(handlers.has(route))return handlers.get(route)(body);if(route==='/api/bot-controls')return{replyMedia:structuredClone(saved)};throw Error('unexpected API '+route);};
  const ui=createReplyMediaUI({api,escapeHtml:esc,toast:v=>toasts.push(v),query});
  const fire=(type,target)=>query('#local-media-card').listeners[type]({target});
  return {ui,query,fire,calls,toasts,handlers,saved};
}
test('manual sticker metadata accepts Chinese tags without duplicate or oversized entries',()=>{
  assert.deepEqual(parseStickerTags('开心， 打招呼,开心'),['开心','打招呼']);
  assert.deepEqual(parseStickerTags(''),[]);
  assert.throws(()=>parseStickerTags('a,b,c,d,e,f,g'),/最多 6/);
  assert.throws(()=>parseStickerTags('字'.repeat(17)),/16 字/);
});
test('manual sticker picker limits local uploads before base64 allocation',()=>{
  for(const name of ['hi.GIF','hi.png','hi.jpg','hi.jpeg','hi.webp'])assert.doesNotThrow(()=>validateStickerFile({name,size:123}));
  for(const file of [{name:'script.svg',size:123},{name:'hi.gif',size:0},{name:'hi.gif',size:8*1024*1024+1}])assert.throws(()=>validateStickerFile(file));
});

test('local edits retain their saved revision through failed writes and shared-pool-independent reloads',async()=>{
  const f=mediaFixture();f.saved.enabled=false;
  const html=await f.ui.page();f.ui.mount();
  assert.doesNotMatch(html,/local-media-enabled|允许机器人使用本地素材/);
  assert.match(html,/原名/);
  f.fire('input',{id:'name',dataset:{localMediaName:'b'.repeat(64)},value:'新名 <img>'});
  assert.equal(f.ui.hasDraft(),true);
  f.handlers.set('/api/bot-controls/media/save',()=>{throw Error('版本已变化');});
  f.fire('click',f.query('#local-media-save'));await tick();
  assert.equal(f.ui.hasDraft(),true);
  const calls=f.calls.length;
  assert.match(await f.ui.page(),/新名 &lt;img&gt;/);assert.equal(f.calls.length,calls);
  f.handlers.set('/api/bot-controls/media/save',body=>{
    assert.equal(body.expectedRevision,'a'.repeat(64));
    assert.equal(Object.hasOwn(body,'enabled'),false);
    return{...f.saved,items:body.items,revision:'c'.repeat(64)};
  });
  f.query('#local-media-save').disabled=false;
  f.fire('click',f.query('#local-media-save'));await tick();
  assert.equal(f.ui.hasDraft(),false);
  f.handlers.set('/api/browse',()=>({path:'D:/fixtures'}));
  f.fire('click',f.query('#local-media-browse'));await tick();
  f.handlers.set('/api/bot-controls/media/import',body=>{
    assert.deepEqual(body,{directory:'D:/fixtures',kind:'image',expectedRevision:'c'.repeat(64)});
    return{...f.saved,added:1,skipped:1};
  });
  f.fire('click',f.query('#local-media-import'));await tick();
  assert.match(f.toasts.at(-1),/已导入 1 张素材/);
  assert.equal(f.calls.some(c=>c.route==='/api/jobs'||c.route.startsWith('/api/sticker-manager')),false);
});

test('a stopped shared sticker service cannot hide local materials and failed local reads cannot hide the shared pool',async t=>{
  const original=globalThis.document;
  globalThis.document={addEventListener(){}};t.after(()=>{globalThis.document=original;});
  for(const unavailable of ['pool','local']){
    const api=async route=>{
      if(route==='/api/bot-controls')return{replyMedia:unavailable==='local'?{error:'本地素材未就绪'}:snapshot()};
      if(route==='/api/sticker-manager'){
        if(unavailable==='pool')throw Error('共享表情池 <未连接>');
        return{scope:'d'.repeat(64),revision:'e'.repeat(64),items:[],count:0,limit:50};
      }
      assert.fail('unexpected API');
    };
    const ui=createStickerManagerUI({api,escapeHtml:esc,icon:()=>'',state:{page:'stickers'},renderPage:async()=>{},toast(){}});
    const html=await ui.page();
    assert.match(html,/<h2>本地图片与 GIF/);assert.match(html,/<h2>账号共享表情池/);
    if(unavailable==='pool'){
      assert.match(html,/共享表情池 &lt;未连接&gt;/);assert.match(html,/id="local-media-save"/);
      assert.match(html,/data-sticker-reload/);assert.doesNotMatch(html,/data-sticker-import/);
    }else{
      assert.match(html,/本地素材未就绪/);assert.doesNotMatch(html,/id="local-media-save"/);assert.match(html,/data-sticker-import/);
    }
  }
});
