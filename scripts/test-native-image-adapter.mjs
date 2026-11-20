import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {WechatOneBotAdapter,DURABLE_UI_PROTOCOL} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import {SELECTION_SCOPE_CAPABILITY} from '../components/qq-bridge/src/core/selection-scope.js';

const id='a'.repeat(64),deliveryId='b'.repeat(64),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const request={kind:'private',target:'123',selfId:'99',id,deliveryId};
const advertise=(adapter,capabilities=[DURABLE_UI_PROTOCOL,'native-image-output-v1'])=>adapter.server.emit('event',{post_type:'meta_event',self_id:99,wechatagent_capabilities:capabilities});
function fixture(){const adapter=new WechatOneBotAdapter();advertise(adapter);return adapter;}
function response(state,extra={}){return {data:{delivery_protocol:DURABLE_UI_PROTOCOL,delivery_id:deliveryId,kind:'private',target:'123',self_id:'99',state,
  ...(state==='confirmed'?{receipt:{type:'wechat-ui-delivery-v1',deliveryId,selfId:'99',kind:'private',target:'123',textSha256:hash('[IMAGE:'+id+']'),
    evidence:{type:'wechat-database-image-v1',deliveryId,sourceImageSha256:id,nativeImageRowConfirmed:true,imageContentVerified:false}}}:{}),...extra}};}
function gifResponse(patch={}){const result=response('confirmed');Object.assign(result.data.receipt.evidence,{type:'wechat-database-gif-v1',sourceImageMd5:'c'.repeat(32),gifContentMd5Matched:true,localType:47,...patch});return result;}
test('native image candidates are capability gated and strip arbitrary paths and wire fields',async()=>{
  const adapter=fixture(),calls=[];adapter.server.action=async(action,params)=>{calls.push({action,params});return {data:{enabled:true,stickers:[
    {id,kind:'sticker',description:'招呼配图',tags:['问候'],path:'D:/private.png',source:'untrusted'},
    {id:'c'.repeat(64),kind:'gif',description:'animation',tags:[]},{id:'d'.repeat(64),kind:'image',description:'bad\nlabel',tags:[]}]}};};
  assert.deepEqual(await adapter.stickerChoices({kind:'private',target:'123',query:'hello'}),[{id,kind:'sticker',description:'招呼配图',tags:['问候'],source:'local-reply-media'}]);
  assert.equal(calls[0].action,'get_sticker_list');advertise(adapter,[DURABLE_UI_PROTOCOL]);assert.deepEqual(await adapter.stickerChoices({kind:'private',target:'123'}),[]);assert.equal(calls.length,1);
});
test('native image sends an ID-only typed segment once and queries until bound confirmation',async()=>{
  const adapter=fixture(),calls=[],states=['queued','paused','submitted','confirmed'];
  adapter.server.action=async(action,params)=>{calls.push({action,params});return response(states.shift());};
  for(let i=0;i<3;i++){const result=await adapter.sendSticker(request);assert.equal(result.confirmed,false);assert.equal(result.pending,true);}
  const result=await adapter.sendSticker(request);assert.equal(result.confirmed,true);assert.equal(result.receipt.evidence.imageContentVerified,false);
  assert.deepEqual(calls.map(row=>row.action),['send_private_msg','get_wechatagent_delivery','get_wechatagent_delivery','get_wechatagent_delivery']);
  assert.deepEqual(calls[0].params.message,[{type:'wechat_image',data:{id}}]);assert.equal(calls[0].params.self_id,'99');
  assert.equal(JSON.stringify(calls).includes('[IMAGE:'),false);assert.equal(adapter.stats.sends,1);
  assert.equal((await adapter.sendSticker(request)).confirmed,true);assert.equal(calls.length,4);
  await assert.rejects(adapter.sendSticker({...request,id:'f'.repeat(64)}),{code:'UI_DELIVERY_ID_CONFLICT'});
});
test('GIF candidates require the GIF capability and trustworthy format/animation metadata',async()=>{
  const adapter=fixture();const gif={id,kind:'sticker',description:'挥手动图',tags:['问候'],format:'gif',animated:true,path:'private.gif',mimeType:'image/gif'};
  adapter.server.action=async()=>({data:{enabled:true,stickers:[gif,{...gif,id:'d'.repeat(64),animated:false},
    {...gif,id:'e'.repeat(64),animated:'true'}, {...gif,id:'f'.repeat(64),animated:undefined}, {...gif,id:'1'.repeat(64),format:undefined}, {...gif,id:'2'.repeat(64),format:'webp'}]}});
  assert.deepEqual(await adapter.stickerChoices(request),[]);assert.equal(adapter.outputCapabilities.gif,false);
  advertise(adapter,[DURABLE_UI_PROTOCOL,'native-image-output-v1','native-gif-output-v1']);
  assert.deepEqual(await adapter.stickerChoices(request),[
    {id,kind:'sticker',description:'挥手动图',tags:['问候'],source:'local-reply-media',format:'gif',animated:true},
    {id:'d'.repeat(64),kind:'sticker',description:'挥手动图',tags:['问候'],source:'local-reply-media',format:'gif',animated:false}]);
  adapter.server.emit('close');assert.equal(adapter.outputCapabilities.gif,false);
  advertise(adapter,[DURABLE_UI_PROTOCOL,'native-gif-output-v1']);assert.equal(adapter.outputCapabilities.gif,false);assert.deepEqual(await adapter.stickerChoices(request),[]);
});
test('GIF delivery accepts exact-MD5 native sticker evidence and queries after reconnect without sending again',async()=>{
  for(const localType of [47,49,8*2**32+49]){
    const adapter=fixture(),calls=[];advertise(adapter,[DURABLE_UI_PROTOCOL,'native-image-output-v1','native-gif-output-v1']);
    adapter.server.action=async(action,params)=>{calls.push({action,params});return calls.length===1?response('submitted'):gifResponse({localType});};
    assert.equal((await adapter.sendSticker(request)).pending,true);adapter.server.emit('close');advertise(adapter,[DURABLE_UI_PROTOCOL]);
    const result=await adapter.sendSticker({...request,receiptOnly:true});assert.equal(result.confirmed,true);assert.equal(result.receipt.evidence.gifContentMd5Matched,true);
    assert.deepEqual(calls.map(call=>call.action),['send_private_msg','get_wechatagent_delivery']);assert.deepEqual(calls[0].params.message,[{type:'wechat_image',data:{id}}]);
  }
  const restored=new WechatOneBotAdapter();advertise(restored,[DURABLE_UI_PROTOCOL]);restored.server.action=async action=>{assert.equal(action,'get_wechatagent_delivery');return gifResponse();};
  assert.equal((await restored.sendSticker({...request,receiptOnly:true,deliveryProtocol:DURABLE_UI_PROTOCOL})).confirmed,true);
});
test('GIF confirmation rejects missing content proof, flattened images, files and wrong content binding',async()=>{
  for(const patch of [{sourceImageMd5:undefined},{sourceImageMd5:'bad'},{sourceImageMd5:'C'.repeat(32)},{gifContentMd5Matched:false},{gifContentMd5Matched:undefined},
    {localType:3},{localType:6*2**32+49},{localType:undefined},{sourceImageSha256:'e'.repeat(64)},{deliveryId:'f'.repeat(64)},{type:'wechat-database-file-v1'}]){
    const adapter=fixture();adapter.server.action=async()=>gifResponse(patch);const result=await adapter.sendSticker(request);
    assert.equal(result.confirmed,false);assert.equal(result.reason,'DELIVERY_RECEIPT_INVALID');assert.equal(adapter.stats.sends,0);
  }
});
test('lost image acknowledgement and restored protocol use receipt-only across capability loss',async()=>{
  const adapter=fixture(),calls=[];adapter.server.action=async(action)=>{calls.push(action);throw new Error('fixture disconnected');};
  assert.equal((await adapter.sendSticker(request)).pending,true);adapter.server.emit('close');
  assert.equal((await adapter.sendSticker(request)).pending,true);assert.equal(calls.length,1);
  const restored=new WechatOneBotAdapter();restored.server.action=async(action)=>{calls.push(action);return response('confirmed');};
  const recovery={...request,receiptOnly:true,deliveryProtocol:DURABLE_UI_PROTOCOL};
  assert.equal((await restored.sendSticker(recovery)).pending,true);assert.equal(calls.length,1);
  advertise(restored,[DURABLE_UI_PROTOCOL]);assert.equal((await restored.sendSticker(recovery)).confirmed,true);assert.equal(calls.at(-1),'get_wechatagent_delivery');
  await assert.rejects(restored.sendSticker({...request,deliveryId:'c'.repeat(64),deliveryProtocol:DURABLE_UI_PROTOCOL}),{code:'UI_NATIVE_IMAGE_UNAVAILABLE'});
});
test('image confirmation requires exact delivery/content/account binding and never accepts queued as delivered',async()=>{
  for(const extra of [{receipt:null},{self_id:'100'},{target:'124'},{delivery_id:'e'.repeat(64)},
    {receipt:{...response('confirmed').data.receipt,textSha256:hash('ordinary text')}},
    {receipt:{...response('confirmed').data.receipt,evidence:{}}},
    ...[{type:'wechat-database-text-v1'},{sourceImageSha256:'c'.repeat(64)},{deliveryId:'d'.repeat(64)},{nativeImageRowConfirmed:false},{imageContentVerified:true}].map(change=>
      ({receipt:{...response('confirmed').data.receipt,evidence:{...response('confirmed').data.receipt.evidence,...change}}}))]){
    const adapter=fixture();adapter.server.action=async()=>response('confirmed',extra);
    const result=await adapter.sendSticker(request);assert.equal(result.confirmed,false);assert.equal(adapter.stats.sends,0);
  }
});
test('image request preserves the event grant and cannot be downgraded to Hook',async()=>{
  const wire=value=>String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0)%2147483647n+1n));
  const scope={version:1,accountRef:'b'.repeat(64),account:'fixture-self',target:'fixture-friend',eventId:'image-event',selectionVersion:1,grantId:'c'.repeat(64),token:'d'.repeat(64)};
  const adapter=fixture(),calls=[];advertise(adapter,[DURABLE_UI_PROTOCOL,'native-image-output-v1',SELECTION_SCOPE_CAPABILITY]);
  const scoped={...request,selfId:wire(scope.account),target:wire(scope.target),selectionRequired:true,selectionScope:scope};
  adapter.server.action=async(action,params)=>{calls.push({action,params});return response('queued',{self_id:scoped.selfId,target:scoped.target});};
  assert.equal((await adapter.sendSticker(scoped)).pending,true);assert.deepEqual(calls[0].params.wechatagent_selection_scope,scope);
  await assert.rejects(adapter.sendSticker({...scoped,selectionScope:{...scope,token:'e'.repeat(64)}}),{code:'UI_DELIVERY_ID_CONFLICT'});
  adapter.server.emit('close');assert.equal((await adapter.sendSticker({...scoped,receiptOnly:true})).pending,true);assert.equal(calls.length,1);
});
test('image abandon is read-only and explicit pre-input failure is never a confirmation',async()=>{
  const adapter=fixture(),calls=[];adapter.server.action=async(action)=>{calls.push(action);return response('unconfirmed');};
  assert.equal((await adapter.sendSticker({...request,abandon:true})).confirmed,false);assert.deepEqual(calls,['get_wechatagent_delivery']);
  const denied=fixture();denied.server.action=async()=>{throw Object.assign(Error('fixture rejected'),{code:'UI_IMAGE_REJECTED',attempted:false});};
  const result=await denied.sendSticker(request);assert.equal(result.state,'failed');assert.equal(result.attempted,false);assert.equal(result.confirmed,false);
});
