import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function prepareInstallerRuntime(destination,node=process.execPath) {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(process.platform!=='win32'||process.arch!=='x64'||major<22||major===22&&minor<13)throw Error('安装包构建需要 64 位 Windows 和 Node.js 22.13 或更高版本。');
  fs.mkdirSync(destination,{recursive:true});
  fs.copyFileSync(node,path.join(destination,'node.exe'));
  return crypto.createHash('sha256').update(fs.readFileSync(node)).digest('hex').slice(0,12);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  prepareInstallerRuntime(path.resolve(import.meta.dirname,'../state/installer-stage/runtime'));
  console.log('已准备安装包内的控制台 Node.js 运行环境。');
}
