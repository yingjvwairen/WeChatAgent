import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {attachOcrQuote,ocrQuoteSource,ocrQuoteMenu,ocrQuotePreview,verifyNoOcrQuote,richOcrSource,matchingQuotePreview} from './qt-quote-ocr.mjs';

const area={left:20,top:20,right:400,bottom:220};
const word=(line,text,x,y,confidence=0.99)=>({line,text,x,y,width:Math.max(1,text.length*12),height:15,confidence});
test('OCR aligns a media run to an independent database anchor and selects the requested bubble',()=>{
  const keys=[{kind:'text',text:'锚点'},{kind:'image'},{kind:'image'}];
  const quote={kind:'image',locator:{rows:keys,index:2,ocrAnchor:0}};
  const row=(top)=>({side:'left',avatar:{left:25,right:55,top,bottom:top+30},
    bubble:{left:65,right:145,top,bottom:top+45},textured:true});
  const rows=[row(30),row(90),row(150)],ocr={words:[word(0,'锚点',75,40)]};
  const resolve=()=>richOcrSource(ocr,area,rows,quote,false,96).line;
  assert.deepEqual(resolve(),rows[2].bubble);
  rows[2].side='right';assert.equal(resolve(),null);rows[2].side='left';
  rows[2].textured=false;assert.equal(resolve(),null);rows[2].textured=true;
  quote.locator.ocrAnchor=undefined;assert.equal(resolve(),null);
  quote.locator.ocrAnchor=0;ocr.words.push(word(3,'锚点',75,160));assert.equal(resolve(),null);
});
test('OCR file titles require a measured card; thumbnails require an unambiguous content match',()=>{
  const key={kind:'file',text:'A.pdf'},quote={kind:'file',locator:{rows:[key],index:0,ocrAnchor:0}};
  const row={side:'left',avatar:{left:24,right:54,top:42,bottom:72},bubble:{left:66,right:200,top:41,bottom:109}};
  const ocr={words:[word(0,'A.pdf',70,45)]};
  assert.ok(richOcrSource(ocr,area,[row],quote,false,96).line);
  row.bubble.bottom=75;assert.equal(richOcrSource(ocr,area,[row],quote,false,96).line,null);
  const signature={bits:'01'.repeat(16),mean:[81,144,50]},view={box:row.bubble,signatures:[signature]};
  assert.equal(matchingQuotePreview([view],[signature],area),view.box);
  assert.equal(matchingQuotePreview([view,view],[signature],area),null);
  assert.equal(matchingQuotePreview([view],[{...signature,bits:'fe'.repeat(16)}],area),null);
});
test('OCR quote selection rejects duplicates, overlapping crops, wrong side and uncertain text',()=>{
  const first=word(0,'周六见',40,35),ocr={words:[first]};
  assert.deepEqual(ocrQuoteSource(ocr,area,'周六见',false),{left:40,top:35,right:76,bottom:50});
  assert.equal(ocrQuoteSource(ocr,area,'周六见',true),null);
  assert.equal(ocrQuoteSource(ocr,area,'周六',false),null);
  for(const second of [word(1,'周六见',270,90),word(1,'范围之外',10,115)])
    assert.equal(ocrQuoteSource({words:[first,second]},area,'周六见',false),null);
  assert.equal(ocrQuoteSource({words:[{...first,confidence:0.93}]},area,'周六见',false),null);
});
test('OCR quote menu requires the chat menu labels and the complete unambiguous preview',()=>{
  const menu={words:[word(0,'复制',38,25),word(1,'转发',38,60),word(2,'引用',38,105)]};
  assert.equal(ocrQuoteMenu(menu,area).top,105);
  assert.equal(ocrQuoteMenu({words:[menu.words[2]]},area),null);
  assert.equal(ocrQuoteMenu({words:[...menu.words,word(3,'引用',38,160)]},area),null);
  const preview={words:[word(0,'小林：周六见',38,35)]};
  assert.equal(ocrQuotePreview(preview,area,'周六见').top,35);
  assert.equal(ocrQuotePreview(preview,area,'周六'),null);
  assert.equal(ocrQuotePreview({words:[...preview.words,word(1,'另一行',40,80)]},area,'周六见'),null);
});
test('native media menus may omit Copy; voice duration and unique rich card preview labels are recognised',()=>{
  const words=[word(0,'收藏',38,25),word(1,'多选',38,60),word(2,'引用',38,105)];
  assert.ok(ocrQuoteMenu({words},area,true,true));assert.equal(ocrQuoteMenu({words},area),null);
  assert.ok(ocrQuotePreview({words:[word(0,'Alice：[语音] 6秒',45,30)]},area,'[语音]','voice'));
  const card=[word(0,'Alice：[文件] x.pdf',45,30),word(1,'13 KB',45,60)];
  assert.ok(ocrQuotePreview({words:card},area,'x.pdf','file'));
  assert.equal(ocrQuotePreview({words:card},area,'y.pdf','file'),null);
});

function fixture(t,{source='周六见',older,preview='小林：周六见'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'quote-ocr-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'state/ui-host/qt-frames');fs.mkdirSync(dir,{recursive:true});
  const header={left:40,top:0,right:185,bottom:35},editor={left:20,top:240,right:380,bottom:330};
  const blank='a'.repeat(64),changed='f'.repeat(64),zero='0'.repeat(64);
  const frame={token:'fixture-token',epoch:'epoch',revision:7,regions:[{rect:header,rgbaSha256:zero},{rect:editor,rgbaSha256:blank}],
    binding:{hwnd:'100',pid:4,processCreatedFileTimeUtc:'9',dpi:96,captureRect:{left:5,top:10,right:405,bottom:350},clientRect:{left:0,top:0,right:400,bottom:340}}};
  let serial=0,chosen=false,scrolled=false;const calls=[],frames=[];
  function image(name){const file=path.join(dir,'qt-'+String(++serial).padStart(32,'0')+'.png');fs.writeFileSync(file,name);frames.push(file);return {file,sha256:zero};}
  const driver={root,active(){},wait:async()=>{},region:k=>({header,editor})[k],config:{ocrBackend:'rapidocr',idleMs:1000,layout:{emptyEditorSha256:blank}},
    textStepBinding(){return{version:1};},discardNativeFrameImage:f=>fs.unlinkSync(f.image.file),
    capture:async regions=>({...frame,regions:regions.map(r=>({rect:typeof r==='string'?({header,editor})[r]:r,rgbaSha256:r==='editor'?(chosen?changed:blank):typeof r==='object'&&scrolled&&older?changed:zero})),image:image(regions.length===3?'history':'editor')}),
    recognize:async({file,region})=>{
      const kind=fs.readFileSync(file,'utf8'),menu=kind==='menu';
      const words=menu?[word(0,'复制',14,12),word(1,'转发',14,40),word(2,'引用',14,75)]
        :kind==='history'?[word(0,scrolled&&older?older:source,50,120)]:chosen?[word(0,preview,55,250)]:[];
      return {imageSha256:zero,width:menu?140:400,height:menu?180:340,region,words};
    },client:{request:async(action,args)=>{
      calls.push(action);
      if(action==='scrollOcrQuoteHistory'){scrolled=true;return {scrolled:true};}
      if(action==='openOcrQuoteMenu')return {ocrQuoteId:'1'.repeat(32)};
      if(action==='captureOcrQuoteMenu')return {ready:true,width:140,height:180,image:image('menu')};
      if(action==='chooseOcrQuoteMenu'){chosen=true;return {chosen:true};}
      if(action==='bindOcrQuotePreview'){assert.equal(args.lineRect.top,250);return {attached:true,quoteToken:'fixture',editorRect:editor};}
      assert.fail(action);
    }}};
  return {driver,frame,job:{account:'self',quote:{sender:'someone',text:'周六见'}},calls,frames};
}
test('OCR verifies source, menu and preview in separate frames and releases screenshots',async t=>{
  const {driver,frame,job,calls,frames}=fixture(t);
  assert.equal(await verifyNoOcrQuote(driver,job,frame),true);
  assert.equal((await attachOcrQuote(driver,job,frame)).attached,true);
  assert.deepEqual(calls,['openOcrQuoteMenu','captureOcrQuoteMenu','chooseOcrQuoteMenu','bindOcrQuotePreview']);
  assert.equal(await verifyNoOcrQuote(driver,job,frame),false);
  assert.ok(frames.every(file=>!fs.existsSync(file)));
});
test('history end and inexact source do not open a context menu or attach a draft',async t=>{
  const {driver,frame,job,calls,frames}=fixture(t,{source:'周六见吗'});
  await assert.rejects(attachOcrQuote(driver,job,frame),{code:'QT_QUOTE_SOURCE_NOT_VISIBLE',attempted:false,quoteDraftUntouched:true});
  assert.deepEqual(calls,['scrollOcrQuoteHistory']);assert.ok(frames.every(file=>!fs.existsSync(file)));
});
test('look up an earlier message in the same guarded history viewport',async t=>{
  const {driver,frame,job,calls}=fixture(t,{source:'最新的文字',older:'周六见'});
  assert.equal((await attachOcrQuote(driver,job,frame)).attached,true);
  assert.equal(calls[0],'scrollOcrQuoteHistory');assert.equal(calls[1],'openOcrQuoteMenu');
});
