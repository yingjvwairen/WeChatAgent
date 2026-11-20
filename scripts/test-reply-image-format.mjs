import test from 'node:test';import assert from 'node:assert/strict';
import {inspectReplyImage,REPLY_IMAGE_MAX_BYTES,REPLY_GIF_MAX_FRAMES,REPLY_GIF_MAX_DECODED_PIXELS} from './reply-image-format.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
const jpeg=(width,height,marker=192)=>{const bytes=Buffer.from([255,216,255,marker,0,11,8,0,1,0,1,1,1,17,0,255,217]);bytes.writeUInt16BE(height,7);bytes.writeUInt16BE(width,9);return bytes;};
const sized=(width,height)=>{const bytes=Buffer.from(png);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;};
function gif({width=1,height=1,frames=2,version='GIF89a',local=false}={}){
  const screen=Buffer.from('47494638396101000100800000000000ffffff','hex');screen.write(version,0,'ascii');screen.writeUInt16LE(width,6);screen.writeUInt16LE(height,8);
  if(local)screen[10]=0;
  const frame=Buffer.from(local?'2c000000000100010080000000ffffff0202440100':'2c0000000001000100000202440100','hex');
  return Buffer.concat([local?screen.subarray(0,13):screen,...Array.from({length:frames},()=>frame),Buffer.from([0x3b])]);
}
test('PNG and baseline/progressive JPEG dimensions are parsed with the same native pixel limits',()=>{
  assert.deepEqual(inspectReplyImage(png),{extension:'png',width:1,height:1,mimeType:'image/png'});
  assert.deepEqual(inspectReplyImage(jpeg(2000,2000)),{extension:'jpg',width:2000,height:2000,mimeType:'image/jpeg'});
  assert.equal(inspectReplyImage(jpeg(4096,976,194)).width,4096);assert.equal(inspectReplyImage(sized(2000,2000)).height,2000);
  for(const bytes of [sized(4097,1),sized(2001,2000),sized(0,1),jpeg(4097,1),jpeg(2001,2000),jpeg(1,0)])assert.throws(()=>inspectReplyImage(bytes),{code:'REPLY_IMAGE_DIMENSIONS_INVALID'});
});
test('APNG control chunks are refused before import even after an IEND chunk',()=>{
  const chunk=Buffer.alloc(20);chunk.writeUInt32BE(8);chunk.write('acTL',4,'ascii');
  for(const bytes of [Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)]),Buffer.concat([png,chunk])])assert.throws(()=>inspectReplyImage(bytes),{code:'REPLY_IMAGE_ANIMATION_UNSUPPORTED'});
  assert.throws(()=>inspectReplyImage(Buffer.from('GIF89a')),{code:'REPLY_IMAGE_FORMAT_INVALID'});
});

test('GIF87a/89a frames retain original bytes and parse local or global palettes without rendering',()=>{
  for(const local of [false,true])for(const version of ['GIF87a','GIF89a']){
    const bytes=gif({local,version}),copy=Buffer.from(bytes),result=inspectReplyImage(bytes);
    assert.deepEqual(result,{width:1,height:1,extension:'gif',mimeType:'image/gif',frameCount:2,animated:true,decodedPixels:2,originalBytesPreserved:true});assert.deepEqual(bytes,copy);
  }
  assert.equal(inspectReplyImage(gif({frames:1})).animated,false);
});
test('GIF LZW handles dictionary references, code-width growth and split data blocks',()=>{
  // clear(3 bits), 0(3), next dictionary entry 6(3), entry 7(3), end(4):
  // the two self-references expand to 1 + 2 + 3 black pixels.
  const bytes=Buffer.from('47494638396106000100800000000000ffffff2c000000000600010000020184015f003b','hex');
  assert.equal(inspectReplyImage(bytes).width,6);
  const wrongLength=Buffer.from(bytes);wrongLength.writeUInt16LE(5,24);assert.throws(()=>inspectReplyImage(wrongLength),{code:'REPLY_IMAGE_FORMAT_INVALID'});
  const missingEnd=Buffer.from(bytes);missingEnd[33]=0;assert.throws(()=>inspectReplyImage(missingEnd),{code:'REPLY_IMAGE_FORMAT_INVALID'});
});

test('GIF animation workload is bounded by canvas pixels times frames, not tiny changed patches',()=>{
  assert.equal(inspectReplyImage(gif({frames:REPLY_GIF_MAX_FRAMES})).frameCount,200);
  assert.throws(()=>inspectReplyImage(gif({frames:REPLY_GIF_MAX_FRAMES+1})),{code:'REPLY_IMAGE_ANIMATION_LIMIT'});
  assert.equal(inspectReplyImage(gif({width:2000,height:2000,frames:20})).decodedPixels,REPLY_GIF_MAX_DECODED_PIXELS);
  assert.throws(()=>inspectReplyImage(gif({width:2000,height:2000,frames:21})),{code:'REPLY_IMAGE_ANIMATION_LIMIT'});
  assert.throws(()=>inspectReplyImage(gif({width:4097,frames:1})),{code:'REPLY_IMAGE_DIMENSIONS_INVALID'});
});

test('GIF control/application/comment blocks preserve frame count and reject malformed extension scope',()=>{
  const bytes=gif(),extensions=Buffer.from('21ff0b4e45545343415045322e30030100000021fe046e6f74650021f904010a000000','hex');
  assert.equal(inspectReplyImage(Buffer.concat([bytes.subarray(0,19),extensions,bytes.subarray(19)])).frameCount,2);
  for(const extra of [Buffer.from('21f904e10a000000','hex'),Buffer.from('21f904010a000200','hex'),Buffer.from('21ff0a4e45545343415045322e3000','hex'),Buffer.from('21fe04616200','hex')])
    assert.throws(()=>inspectReplyImage(Buffer.concat([bytes.subarray(0,19),extra,bytes.subarray(19)])),{code:'REPLY_IMAGE_FORMAT_INVALID'});
  assert.throws(()=>inspectReplyImage(Buffer.concat([bytes.subarray(0,19),Buffer.from('2101','hex'),bytes.subarray(19)])),{code:'REPLY_IMAGE_FORMAT_UNSUPPORTED'});
});

test('GIF rejects truncation, missing end, bad frame rectangles and corrupt LZW before native input',()=>{
  const source=gif();
  for(let length=4;length<source.length;length++)assert.throws(()=>inspectReplyImage(source.subarray(0,length)),undefined,'length '+length);
  for(const mutate of [b=>b.write('GIF00a',0),b=>b[10]=0,b=>b[20]=1,b=>b[28]=0x18,b=>b[29]=1,b=>b[31]=0,b=>b[31]=0x54,b=>b[31]=0x64]){
    const changed=Buffer.from(source);mutate(changed);assert.throws(()=>inspectReplyImage(changed));
  }
  assert.throws(()=>inspectReplyImage(Buffer.concat([source,Buffer.from([0])])),{code:'REPLY_IMAGE_FORMAT_INVALID'});
});
test('truncated chunks, missing dimensions and file-size overflow fail before native decoding',()=>{
  for(const bytes of [png.subarray(0,25),png.subarray(0,-12),Buffer.from([255,216,255,217]),jpeg(1,1).subarray(0,12)])assert.throws(()=>inspectReplyImage(bytes),{code:'REPLY_IMAGE_FORMAT_INVALID'});
  assert.throws(()=>inspectReplyImage(Buffer.alloc(REPLY_IMAGE_MAX_BYTES+1)),{code:'REPLY_IMAGE_SIZE_INVALID'});
  const malformed=Buffer.from(png);malformed.writeUInt32BE(0xffffffff,33);assert.throws(()=>inspectReplyImage(malformed),{code:'REPLY_IMAGE_FORMAT_INVALID'});
});
