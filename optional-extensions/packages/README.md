# 第一方插件包

在“能力 → 能力目录”导入 ZIP，核对权限并选择允许使用的聊天。桌面安装器已预置两个语音插件，可以直接打开配置页。插件默认关闭。

| 插件包 | 用途 | 使用说明 |
| --- | --- | --- |
| [speech-recognition-1.7.2.zip](speech-recognition-1.7.2.zip) | 把微信语音和分段视频音轨转成文字 | [语音识别](../../docs/VOICE_INPUT.md) |
| [speech-synthesis-1.8.2.zip](speech-synthesis-1.8.2.zip) | 合成语音回复，支持专用 TTS、本机 GPT-SoVITS 和 Realtime | [语音对话](../../docs/VOICE_OUTPUT.md) |
| [fish-notebook-1.1.1.zip](fish-notebook-1.1.1.zip) | 在获授权的聊天中查询和使用记事本 | [鱼的记事本](../../docs/FISH_NOTEBOOK.md) |

每个 ZIP 都有同名的 `.sha256` 校验文件。修改插件源码后，在仓库根目录运行 `npm run plugin:pack` 生成压缩包与校验文件，再运行 `npm run plugin:check` 核对包内文件、权限和宿主能力声明。
