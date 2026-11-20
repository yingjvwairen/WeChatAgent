export const MAIN_PAGES=['overview','chats','roles','extensions','stickers','memory','settings'];
const seconds = {transform:'seconds', min:0, step:0.001};
export const REPLY_RHYTHM_FIELDS = [
  ['消息合并等待 / 秒','social.batch_ms',{...seconds,max:60,help:'把短时间内收到的消息合并到同一轮判断。'}],
  ['私聊回复最小间隔 / 秒','social.private_min_interval_ms',{...seconds,max:3600}],
  ['群聊回复最小间隔 / 秒','social.min_interval_ms',{...seconds,max:3600}],
  ['每分钟群回复上限 / 条','social.max_per_minute',{min:1,max:1000,step:1}],
  ['每十分钟群回复上限 / 条','social.max_per_ten_minutes',{min:1,max:10000,step:1}],
];

export function displaySettingValue(value, {transform, defaultValue}) {
  if (value === undefined) value = defaultValue;
  if (transform === 'lines') return (value ?? []).join('\n');
  if (transform === 'seconds') return value / 1000;
  return value;
}

export function readSettingInput(input) {
  const {transform} = input.dataset;
  if (transform === 'lines') return input.value.split('\n').map(line => line.trim()).filter(Boolean);
  if (transform === 'seconds') return Math.round(Number(input.value) * 1000);
  if (input.type === 'checkbox') return input.checked;
  return input.type === 'number' ? Number(input.value) : input.value;
}
export const SETTINGS_SECTIONS={chat:'聊天默认值',assistant:'助手设置',context:'上下文',connections:'微信与 DSH',diagnostics:'诊断',logs:'运行日志',advanced:'开发者选项',appearance:'外观与数据'};
export const STICKER_SECTIONS={library:'我的表情',collection:'自动收集',sources:'来源与搜索',sending:'发送设置'};
export const CAPABILITY_SECTIONS={catalog:'能力目录',network:'联网与阅读',speech:'语音服务',dsh:'DSH 能力'};
const aliases={sessions:{page:'chats',detail:'usage'},behavior:{page:'settings',section:'chat'},connections:{page:'settings',section:'connections'},tools:{page:'settings',section:'diagnostics'},logs:{page:'settings',section:'logs'}};
export function consoleRoute(hash=''){
 const [page,section,detail]=String(hash).replace(/^#/,'').split('/');
 if(aliases[page])return {...aliases[page]};
 if(page==='setup')return {page:'setup'};
 if(page==='memory')return {page,section:['summaries','notebook'].includes(section)?section:'members'};
 if(page==='settings'&&section==='bot')return detail==='reader-recovery'?{page:'settings',section:'diagnostics'}:{page:'overview'};
 if(page==='settings')return {page,section:Object.hasOwn(SETTINGS_SECTIONS,section)?section:'chat'};
 if(page==='stickers')return {page,section:Object.hasOwn(STICKER_SECTIONS,section)?section:'library'};
 if(page==='extensions')return {page,section:Object.hasOwn(CAPABILITY_SECTIONS,section)?section:'catalog'};
 return {page:MAIN_PAGES.includes(page)?page:'overview'};
}
export const routeKey=route=>route.page+(route.section?'/'+route.section:'');
export const featureLocation=id=>({'native-speech':'#extensions/speech','native-search':'#extensions/network','native-web-reader':'#extensions/network','native-stickers':'#stickers/sending','dsh-meme':'#stickers/sources','native-proactive':'#settings/chat','native-context':'#settings/context'})[id]??null;
export function filterChats(rows,{kind='all',mode='all',query=''}={}){
 const needle=query.trim().toLocaleLowerCase();
 return rows.filter(row=>(kind==='all'||row.kind===kind)&&(mode==='all'||row.mode===mode)&&(!needle||[row.name,row.id,row.persona].join(' ').toLocaleLowerCase().includes(needle)));
}
export function effectiveChatFeature(config,key,feature){
 const settings=config.wechat[feature]??{},own=Object.hasOwn(settings.chats??{},key),value=settings.chats?.[key];
 if(feature==='proactive')return {enabled:settings.enabled===true&&value===true,source:settings.enabled!==true?'总开关关闭':value===true?'本聊天已加入':'本聊天未加入'};
 if(feature==='context')return {enabled:settings.enabled===true&&value!==0,source:settings.enabled!==true?'总开关关闭':value===0?'本聊天关闭':own?'本聊天阈值':'继承默认阈值'};
 const fallback=feature==='stickers'?settings.enabled!==false:settings.enabled===true;
 return {enabled:own?value===true:fallback,source:own?'本聊天单独设置':'继承账号默认'};
}
