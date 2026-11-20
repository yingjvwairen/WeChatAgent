import fs from 'node:fs';
import path from 'node:path';

const fault=code=>Object.assign(new Error(code),{code});
const sourceUnavailable=()=>Object.assign(fault('QT_QUOTE_SOURCE_NOT_VISIBLE'),{attempted:false,quoteDraftUntouched:true});
const contains=(a,b)=>b.left>=a.left&&b.top>=a.top&&b.right<=a.right&&b.bottom<=a.bottom;
const sameRect=(a,b)=>a&&b&&['left','top','right','bottom'].every(k=>a[k]===b[k]);
const full=(width,height)=>({left:0,top:0,right:width,bottom:height});
function linesIn(ocr,area){
  if(!Array.isArray(ocr?.words)||ocr.words.length>2000)return null;
  const groups=new Map();
  for(const word of ocr.words) {
    if(typeof word.text!=='string'||!word.text.trim()||/[\n\r\0]/.test(word.text)||!Number.isSafeInteger(word.line)||
       ![word.x,word.y,word.width,word.height].every(Number.isFinite)||word.width<=0||word.height<=0)return null;
    const box={left:Math.floor(word.x),top:Math.floor(word.y),right:Math.ceil(word.x+word.width),bottom:Math.ceil(word.y+word.height)};
    if(box.left>=area.right||box.top>=area.bottom||box.bottom<=area.top||box.right<=area.left)continue;
    if(!contains(area,box))return null;
    if(!groups.has(word.line))groups.set(word.line,[]);
    groups.get(word.line).push({...word,box});
  }
  return [...groups.values()].map(words=>{
    words.sort((a,b)=>a.x-b.x);
    return {texts:[words.map(w=>w.text).join(''),words.map(w=>w.text).join(' ')],
      confident:words.every(w=>w.confidence===undefined||Number.isFinite(w.confidence)&&w.confidence>=0.97),
      box:{left:Math.min(...words.map(w=>w.box.left)),right:Math.max(...words.map(w=>w.box.right)),
           top:Math.min(...words.map(w=>w.box.top)),bottom:Math.max(...words.map(w=>w.box.bottom))}};
  });
}
export function ocrQuoteSource(ocr,area,text,fromSelf){
  return findSource(ocr,area,text,fromSelf).line;
}
function findSource(ocr,area,text,fromSelf){
  if(!text||/[\r\n]/.test(text)||text!==text.trim())return {line:null,absent:false};
  const matches=linesIn(ocr,area)?.filter(line=>line.texts.includes(text));
  if(matches?.length!==1||!matches[0].confident)return {line:null,absent:matches?.length===0};
  const {box}=matches[0],mid=(area.left+area.right)/2;
  return {line:(fromSelf?box.right<=mid:box.left>=mid)?null:box,absent:false};
}
const mediaLabels={
  image:['图片','圖片','Photo','Image'],voice:['语音','語音','Voice'],video:['视频','影片','Video'],
  file:['文件','檔案','File'],sticker:['表情','动画表情','Sticker'],link:['链接','連結','Link'],
  record:['聊天记录','聊天記錄','Chat History'],card:['名片','位置','小程序','Contact Card']
};
const cardKinds=new Set(['link','file','record','card']);

export function richOcrSource(ocr,area,rows,quote,fromSelf,dpi){
  const {rows:keys,index,ocrAnchor}=quote.locator;
  const lines=linesIn(ocr,area),scale=dpi/96;
  const anchor=keys[ocrAnchor];
  if(!lines||!Number.isInteger(ocrAnchor)||!(anchor?.kind==='text'||cardKinds.has(anchor?.kind))||!Array.isArray(rows)||rows.length>60)return {line:null,absent:false};
  if(!keys.length||!lines.some(line=>line.texts.includes(keys[ocrAnchor].text)))return {line:null,absent:true};
  if(lines.filter(line=>line.texts.includes(keys[ocrAnchor].text)).length!==1)return {line:null,absent:false};
  function point(row,key){
    const box=row?.bubble,avatar=row?.avatar;
    if(!box||!avatar||!contains(area,box)||!contains(area,avatar))return null;
    const width=box.right-box.left,height=box.bottom-box.top;
    const inside=lines.filter(line=>contains(box,line.box));
    if(key.text){
      const named=inside.filter(line=>line.texts.includes(key.text));
      if(named.length!==1||!named[0].confident)return null;
      if(cardKinds.has(key.kind)&&(width<100*scale||height<46*scale))return null;
      return named[0].box;
    }
    if(key.kind==='voice'){
      const seconds=inside.filter(line=>line.confident&&line.texts.some(t=>/^[1-9]\d?\s*(?:["″”]|''|秒|s)$/i.test(t)));
      if(seconds.length!==1||height>75*scale)return null;
    }else if(!['image','video','sticker'].includes(key.kind)||!row.textured||height<38*scale||width<38*scale)return null;
    return box;
  }
  const matches=[];
  for(let start=0;start+keys.length<=rows.length;start++){
    const run=rows.slice(start,start+keys.length);
    // Consistent avatar rails keep a square inside a picture or a nested
    // screenshot from masquerading as another message in this run.
    if(run.some(row=>run.some(other=>row.side===other.side&&(Math.abs(row.avatar.left-other.avatar.left)>3*scale||
        Math.abs(row.avatar.right-other.avatar.right)>3*scale))))continue;
    const points=run.map((row,i)=>point(row,keys[i]));
    if(points.every(Boolean)&&run[index].side===(fromSelf?'right':'left'))matches.push({line:points[index],signatures:run[index].signatures});
  }
  return matches.length===1?{...matches[0],absent:false}:{line:null,absent:false};
}

export function matchingQuotePreview(previews,source,editor) {
  if(!Array.isArray(previews)||!Array.isArray(source)||!source.length)return null;
  function similar(a,b){
    if(!/^[0-9a-f]{32}$/.test(a?.bits)||!/^[0-9a-f]{32}$/.test(b?.bits)||a.mean?.length!==3||b.mean?.length!==3||
       a.mean.some((v,i)=>Math.abs(v-b.mean[i])>12))return false;
    let different=BigInt('0x'+a.bits)^BigInt('0x'+b.bits),count=0;
    while(different){different&=different-1n;if(++count>7)return false;}
    return true;
  }
  const matches=previews.filter(tile=>tile.box&&contains(editor,tile.box)&&tile.signatures?.some(a=>source.some(b=>similar(a,b))));
  return matches.length===1?matches[0].box:null;
}

export function ocrQuoteMenu(ocr,area,requireConfidence=true,media=false){
  const lines=linesIn(ocr,area);
  if(!lines)return null;
  const matches=lines.filter(line=>line.texts.some(t=>['引用','Quote'].includes(t)));
  if(matches.length!==1||requireConfidence&&!matches[0].confident)return null;
  // Distinguish a chat-bubble menu from an unrelated window with the same word.
  const copy=lines.find(line=>line.confident&&line.texts.some(t=>['复制','Copy'].includes(t)));
  const forward=lines.find(line=>line.confident&&line.texts.some(t=>['转发','Forward'].includes(t)));
  const aligned=line=>line&&Math.abs(line.box.left-matches[0].box.left)<=Math.max(8,line.box.bottom-line.box.top);
  if(media){
    const others=lines.filter(line=>line.confident&&aligned(line)&&line.texts.some(t=>['复制','Copy','转发','Forward','收藏','Favorite','多选','Select','删除','Delete','转换为文字','转文字'].includes(t)));
    if(others.length<2)return null;
  }else if(!copy||!forward||copy===forward||![copy,forward].every(aligned))return null;
  return matches[0].box;
}
export function ocrQuotePreview(ocr,area,text,kind){
  const lines=linesIn(ocr,area);
  if(!lines||(!kind&&lines.length!==1)||lines.length>5)return null;
  const allowed=new Set([text]);
  for(const label of mediaLabels[kind]??[]){
    allowed.add('['+label+']');if(cardKinds.has(kind)){allowed.add('['+label+'] '+text);allowed.add('['+label+']'+text);}
  }
  const validValue=value=>allowed.has(value)||kind==='voice'&&/^\[(?:语音|語音|Voice)\] ?[1-9]\d?\s*(?:秒|["″”]|s)$/i.test(value);
  const matches=lines.filter(line=>line.confident&&line.texts.some(label=>{
    if(validValue(label))return true;
    const sep=label.search(/[:：]/);
    return sep>0&&sep<=128&&validValue(label.slice(sep+1).replace(/^ /,''));
  }));
  return matches.length===1?matches[0].box:null;
}

async function readImage(driver,image,width,height,area,signal,model='small') {
  const file=image?.file,dir=path.join(driver.root,'state/ui-host/qt-frames');
  if(typeof file!=='string'||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file))||path.dirname(file)!==dir||
     fs.realpathSync.native(file)!==file||!/^[a-f0-9]{64}$/.test(image.sha256))throw fault('QT_QUOTE_FRAME_UNVERIFIED');
  const region=driver.config.ocrBackend==='rapidocr'?area:undefined;
  const result=await driver.recognize({file,backend:driver.config.ocrBackend,model,...(region?{region}:{}),signal});
  driver.active();
  if(result.imageSha256!==image.sha256||result.width!==width||result.height!==height||
     (region&&!sameRect(result.region,region)))throw fault('QT_QUOTE_FRAME_UNVERIFIED');
  return result;
}
async function measureQuote(driver,snap,area,mode,signal){
  const {runQtLayoutPython}=await import('./qt-auto-layout.mjs');
  const {right:width,bottom:height}=snap.binding.clientRect;
  const result=await runQtLayoutPython({root:driver.root,script:'qt-auto-layout-image.py',signal,input:{
    version:1,mode,image:snap.image.file,imageSha256:snap.image.sha256,width,height,dpi:snap.binding.dpi,history:area}});
  if(!result.ok||result.readOnly!==true||result.inputSent!==false||result.imageSha256!==snap.image.sha256||!sameRect(result.history,area))throw fault('QT_QUOTE_FRAME_UNVERIFIED');
  return result;
}
const guard=(frame,driver)=>({token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:driver.config.idleMs});
function sameView(a,b){
  return a.revision===b.revision&&a.epoch===b.epoch&&a.regions[0].rgbaSha256===b.regions[0].rgbaSha256&&
    ['hwnd','pid','processCreatedFileTimeUtc','dpi'].every(k=>a.binding[k]===b.binding[k])&&sameRect(a.binding.captureRect,b.binding.captureRect);
}
function emptyEditor(frame,driver){
  const layout=driver.config.layout;
  return [layout.emptyEditorSha256,...(layout.emptyEditorSha256s??[])].some(hash=>typeof hash==='string'&&hash===frame.regions.at(-1)?.rgbaSha256);
}
// Called only for an OCR quote created in this editor. A changed layout cannot
// establish that the previous quote has been cleared.
export async function verifyNoOcrQuote(driver,job,frame,signal){
  const editor=driver.region('editor'),snap=await driver.capture(['header','editor'],true);
  try{
    if(!sameView(frame,snap)||!sameRect(snap.regions[1]?.rect,editor)||!emptyEditor(snap,driver))return false;
    const {right,bottom}=snap.binding.clientRect;
    return linesIn(await readImage(driver,snap.image,right,bottom,editor,signal),editor)?.length===0;
  }finally{driver.discardNativeFrameImage(snap);}
}
export async function attachOcrQuote(driver,job,frame,signal) {
  const header=driver.region('header'),editor=driver.region('editor'),text=job.quote.text,rich=Boolean(job.quote.kind);
  const history={left:editor.left,top:header.bottom,right:editor.right,bottom:editor.top};
  if(history.bottom<=history.top||text.length>4000||/[\r\n]/.test(text)||rich&&!Number.isInteger(job.quote.locator?.ocrAnchor))throw sourceUnavailable();
  const {right:width,bottom:height}=frame.binding.clientRect;
  const scrollDeadline=Date.now()+6000;
  let opened,previousHash,sourceSignatures;
  for(let page=0;page<=8;page++){
    const snap=await driver.capture(['header',history,'editor'],true);
    try{
      if(!sameView(frame,snap)||!emptyEditor(snap,driver))throw fault('QT_QUOTE_DRAFT_PRESENT');
      const historyHash=snap.regions[1].rgbaSha256;
      if(previousHash===historyHash)break;
      const ocr=await readImage(driver,snap.image,width,height,history,signal);
      let source;
      if(rich){
        const layout=await measureQuote(driver,snap,history,'quote-rows',signal);
        source=richOcrSource(ocr,history,layout.rows,job.quote,job.quote.sender===job.account,snap.binding.dpi);
      }else source=findSource(ocr,history,text,job.quote.sender===job.account);
      const {line,absent}=source;
      const request={...guard(snap,driver),stepBinding:driver.textStepBinding(job)};
      if(line){
        if(['image','video','sticker'].includes(job.quote.kind))sourceSignatures=source.signatures;
        opened=await driver.client.request('openOcrQuoteMenu',{...request,lineRect:line});
        break;
      }
      // Never scroll past an ambiguous/low-confidence candidate in order to
      // turn it into a unique match on the next viewport.
      if(!absent||page===8||Date.now()>=scrollDeadline)break;
      await driver.client.request('scrollOcrQuoteHistory',request);previousHash=historyHash;
    }finally{driver.discardNativeFrameImage(snap);}
    await driver.wait(120);
  }
  if(!opened)throw sourceUnavailable();
  const ocrQuoteId=opened?.ocrQuoteId;
  if(!/^[a-f0-9]{32}$/.test(ocrQuoteId))throw fault('QT_QUOTE_MENU_UNCONFIRMED');
  let menu;
  const deadline=Date.now()+1400;
  do{
    driver.active();menu=await driver.client.request('captureOcrQuoteMenu',{ocrQuoteId});
    if(!menu.ready)await driver.wait(25);
  }while(!menu.ready&&Date.now()<deadline);
  if(!menu.ready)throw fault('QT_QUOTE_MENU_UNAVAILABLE');
  try{
    const bounds=full(menu.width,menu.height);
    const ocr=await readImage(driver,menu.image,menu.width,menu.height,bounds,signal);
    let lineRect=ocrQuoteMenu(ocr,bounds,true,rich);
    if(!lineRect&&driver.config.ocrBackend==='rapidocr'&&ocrQuoteMenu(ocr,bounds,false,rich)){
      const retry=await readImage(driver,menu.image,menu.width,menu.height,bounds,signal,'medium');
      lineRect=ocrQuoteMenu(retry,bounds,true,rich);
    }
    if(!lineRect)throw fault('QT_QUOTE_MENU_UNAVAILABLE');
    await driver.client.request('chooseOcrQuoteMenu',{ocrQuoteId,lineRect});
  }finally{driver.discardNativeFrameImage(menu);}
  const previewDeadline=Date.now()+1400;
  do{
    driver.active();
    const after=await driver.capture(['header','editor'],true);
    try{
      if(!sameView(frame,after))throw fault('QT_QUOTE_WINDOW_CHANGED');
      if(!emptyEditor(after,driver)){
        const ocr=await readImage(driver,after.image,width,height,editor,signal);
        let lineRect=ocrQuotePreview(ocr,editor,text,job.quote.kind);
        if(!lineRect&&sourceSignatures?.length){
          const view=await measureQuote(driver,after,editor,'quote-preview',signal);
          lineRect=matchingQuotePreview(view.previews,sourceSignatures,editor);
        }
        if(lineRect)return await driver.client.request('bindOcrQuotePreview',{...guard(after,driver),ocrQuoteId,lineRect});
      }
    }finally{driver.discardNativeFrameImage(after);}
    await driver.wait(25);
  }while(Date.now()<previewDeadline);
  throw fault('QT_QUOTE_PREVIEW_UNVERIFIED');
}
