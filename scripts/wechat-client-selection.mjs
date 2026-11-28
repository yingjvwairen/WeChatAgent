import { DESKTOP_WECHAT_VERSION } from './desktop-settings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from './console-process.mjs';

const execute = promisify(execFile);
const invalid = message => Object.assign(new Error(message), { status: 400 });
// Read file metadata only. Never start WeChat or load the selected executable.
export async function probeWeChatExecutable(executable) {
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $exe=$env:WECHATAGENT_SELECTED_CLIENT; $v=(Get-Item -LiteralPath $exe).VersionInfo.FileVersion.Trim(); if($v -notmatch '^\\d+\\.\\d+\\.\\d+\\.\\d+$'){throw 'Invalid file version'}; $core=Join-Path (Split-Path -Parent $exe) ($v+'\\Weixin.dll'); $exists=Test-Path -LiteralPath $core -PathType Leaf; $s=Get-AuthenticodeSignature -LiteralPath $exe; $cv=''; $signed=$false; if($exists){$cv=(Get-Item -LiteralPath $core).VersionInfo.FileVersion.Trim(); $cs=Get-AuthenticodeSignature -LiteralPath $core; $signed=$cs.Status -eq 'Valid' -and $cs.SignerCertificate.Subject -match 'Tencent'}; @{version=$v;coreVersion=$cv;coreExists=$exists;signatureValid=($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Tencent');coreSignatureValid=$signed} | ConvertTo-Json -Compress`;
  try {
    const result = await execute(
      windowsPowerShellExecutable(),
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        windowsHide: true,
        shell: false,
        timeout: 15000,
        maxBuffer: 65536,
        env: { ...windowsPowerShellEnvironment(), WECHATAGENT_SELECTED_CLIENT: executable },
      },
    );
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  } catch {
    throw invalid('无法读取微信程序版本或数字签名，请确认文件完整、路径可访问后重试。');
  }
}

export async function inspectWeChatClient({ root, executable, probe = probeWeChatExecutable }) {
  if (typeof executable !== 'string' || !executable.trim() || executable.length > 1024 || /[\0\r\n"]/.test(executable))
    throw invalid('请填写有效的微信程序路径。');
  const selected = executable.trim(),
    resolved = path.resolve(root, selected);
  if (
    path.basename(resolved).toLowerCase() !== 'weixin.exe' ||
    !fs.existsSync(resolved) ||
    !fs.statSync(resolved).isFile()
  )
    throw invalid('请选择存在的 Weixin.exe 程序。');
  const info = await probe(resolved);
  const version = info?.version;
  if (version !== DESKTOP_WECHAT_VERSION)
    throw invalid('当前桌面发送支持微信 ' + DESKTOP_WECHAT_VERSION + '，请选择已安装的对应版本。');
  if (info.signatureValid !== true) throw invalid('微信程序的腾讯数字签名验证失败，配置未保存。');
  if (info.coreExists !== true || info.coreVersion !== version)
    throw invalid('微信启动器与 Weixin.dll 版本不一致或核心文件缺失，请重新准备完整客户端。');
  if (info.coreSignatureValid !== true) throw invalid('微信核心文件的腾讯数字签名验证失败，配置未保存。');
  if (fs.existsSync(path.join(path.dirname(resolved), 'version.dll')))
    throw invalid('请选择没有旧发送代理 DLL 的微信安装目录。');
  return { path: selected, version, backend: 'wechat-ui' };
}
