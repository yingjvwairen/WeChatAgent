import fs from 'node:fs';
import {readSpeechProviders} from './speech-provider-settings.mjs';
import {synthesizeCloud,transcribeCloud} from './cloud-speech.mjs';

/** Operator-triggered diagnostics always use the same bundled sentence. */
export async function checkSpeechProvider(root,{kind,expectedVersion}={},options={}) {
  if(!['asr','tts'].includes(kind))throw Object.assign(Error('请选择要测试的语音服务。'),{status:400});
  const settings=readSpeechProviders({root,capability:kind});
  if(settings.version!==expectedVersion||settings[kind].mode!=='cloud')
    throw Object.assign(Error('请先保存云端设置，再测试当前配置。'),{status:409});
  try{
    if(kind==='asr'){
      const sample=fs.readFileSync(new URL('./fixtures/speech-service-test.wav',import.meta.url));
      const {text}=await transcribeCloud(settings.asr,sample,options);
      return {kind,text:text.slice(0,300),matched:text.replace(/[^\p{L}\p{N}]/gu,'').includes('语音识别测试')};
    }
    const {segments}=await synthesizeCloud(settings.tts,'这是微信语音合成测试。',options);
    const sample=segments[0];
    if(segments.length!==1||sample.audio.length>512*1024)throw Error('Unexpected preview length');
    return {kind,wav:sample.audio.toString('base64'),durationMs:sample.durationMs};
  }catch(error){
    const reason={
      VOICE_CLOUD_AUTH_FAILED:'服务拒绝了密钥，请检查密钥和模型访问权限。',
      VOICE_CLOUD_TIMEOUT:'语音服务响应超时。',
      VOICE_CLOUD_WAV_INVALID:'合成服务未返回支持的 WAV 音频。',
    }[error?.code];
    throw Object.assign(Error(reason??'语音服务测试失败，请核对接口地址、模型和返回格式。'),{status:502});
  }
}
