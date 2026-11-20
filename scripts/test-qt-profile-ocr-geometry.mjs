import test from 'node:test';
import assert from 'node:assert/strict';
import { observedProfileAlias } from './qt-visual-driver.mjs';

const area={left:0,top:0,right:492,bottom:479},expected='wxid_fixture_longabc';
const profile=()=>({words:[
  {text:'Fixture',x:187,y:73,width:72,height:32,line:1,confidence:.999},
  {text:'微信号：wxid_fixture_long',x:189,y:112,width:229,height:28,line:2,confidence:.97624},
  {text:'abc',x:258,y:136,width:28,height:28,line:3,confidence:.98643},
  {text:'地区：中国',x:74,y:206,width:100,height:27,line:4,confidence:.99},
]});

test('wrapped profile ID accepts adjacent distinct OCR lines with small glyph-box padding overlap',()=>{
  assert.deepEqual(observedProfileAlias(profile(),area,expected),{left:189,top:112,right:418,bottom:164});
});

test('a separate left column cannot interrupt the immediately adjacent ID continuation',()=>{
  for(const text of ['x','其他字段'])for(const confidence of [.999,.4]){
    const ocr=profile();ocr.words.push({text,x:2,y:120,width:18,height:22,line:6,confidence});
    assert.deepEqual(observedProfileAlias(ocr,area,expected),{left:189,top:112,right:418,bottom:164});
  }
});

test('the left-column exclusion needs a full line-height gap and never skips a touching row',()=>{
  for(const [x,accepted] of [[143,true],[144,false],[171,false],[189,false]]){
    const ocr=profile();ocr.words.push({text:'x',x,y:120,width:18,height:22,line:6,confidence:.999});
    assert.equal(Boolean(observedProfileAlias(ocr,area,expected)),accepted);
  }
});

test('left-column exclusion does not weaken full identity, confidence, or global label uniqueness',()=>{
  for(const change of [o=>o.words[1].confidence=.72553,o=>o.words[2].text+='x',o=>o.words[2].confidence=.96999,o=>o.words.at(-1).text='微信号：other']){
    const ocr=profile();ocr.words.push({text:'x',x:2,y:120,width:18,height:22,line:6,confidence:.999});change(ocr);
    assert.equal(observedProfileAlias(ocr,area,expected),null);
  }
});

test('same-column conflicts cannot be skipped to find a matching suffix',()=>{
  for(const [text,confidence] of [['wrong',.999],['abc',.5],['其他字段',.999]]){
    const ocr=profile();ocr.words.push({text,x:258,y:120,width:30,height:20,line:6,confidence});
    assert.equal(observedProfileAlias(ocr,area,expected),null);
  }
  const paired=profile();paired.words.push({...paired.words[2],x:320,text:'wrong',line:6});
  assert.equal(observedProfileAlias(paired,area,expected),null);
});

test('the three-line bound refuses a fourth adjacent ASCII row instead of accepting a truncated identity',()=>{
  const words=[['微信号：wxid_',189,112],['fixture_',258,137],['abc',258,162]].map(([text,x,y],line)=>({text,x,y,width:100,height:20,line,confidence:.999}));
  assert.ok(observedProfileAlias({words},area,'wxid_fixture_abc'));
  for(const x of [258,188,169])assert.equal(observedProfileAlias({words:[...words,{text:'extra',x,y:187,width:100,height:20,line:4,confidence:.999}]},area,'wxid_fixture_abc'),null);
  assert.equal(observedProfileAlias({words:[...words,{text:'extra',x:258,y:187,width:100,height:40,line:4,confidence:.999}]},area,'wxid_fixture_abc'),null);
  const complete=[{...words[0],text:'微信号：wxid_fixture_abc'}];
  assert.equal(observedProfileAlias({words:[...complete,{text:'extra',x:188,y:137,width:100,height:20,line:1,confidence:.999}]},area,'wxid_fixture_abc'),null);
});

for(const [label,change] of [
  ['same-row text',o=>o.words[2].y=112],
  ['overlapping line',o=>o.words[2].y=132],
  ['reverse-order continuation',o=>o.words[2].y=90],
  ['duplicate overlapping continuation',o=>o.words.push({...o.words[2],line:6})],
  ['repeated continuation with insufficient advance',o=>o.words.push({...o.words[2],y:140,line:6})],
  ['short continuation with excessive proportional overlap',o=>o.words[2].height=8],
  ['distant line',o=>o.words[2].y=190],
  ['leftward continuation',o=>o.words[2].x=180],
  ['low-confidence character',o=>o.words[2].confidence=.96999],
  ['low-confidence label',o=>o.words[1].confidence=.96999],
  ['different full identity',o=>o.words[2].text='abC'],
  ['non-ASCII continuation',o=>o.words[2].text='ａｂｃ'],
  ['another label',o=>o.words.push({text:'微信号：another',x:74,y:260,width:200,height:28,line:5,confidence:.99})],
  ['intervening non-ID line',o=>o.words.push({text:'其他字段',x:189,y:130,width:50,height:12,line:6,confidence:.99})],
])test(`wrapped profile ID still refuses ${label}`,()=>{
  const ocr=profile();change(ocr);assert.equal(observedProfileAlias(ocr,area,expected),null);
});
