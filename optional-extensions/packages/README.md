# 第一方插件包

在“能力 → 能力目录”导入 ZIP，核对权限并选择允许使用的聊天。桌面安装器的语音设置入口在“能力 → 语音服务”。插件默认关闭。

| 插件包 | 用途 | 使用说明 |
| --- | --- | --- |
| [speech-synthesis-1.8.3.zip](speech-synthesis-1.8.3.zip) | 合成语音回复、转写收到的语音 | [语音服务](../../docs/VOICE_OUTPUT.md) |
| [speech-recognition-1.7.2.zip](speech-recognition-1.7.2.zip) | 现有独立转写配置和自定义请求协议 | [兼容识别插件](../speech-recognition/README.md) |
| [fish-notebook-1.1.1.zip](fish-notebook-1.1.1.zip) | 在获授权的聊天中查询和使用记事本 | [鱼的记事本](../../docs/FISH_NOTEBOOK.md) |

每个 ZIP 都有同名的 `.sha256` 校验文件。修改插件源码后，在仓库根目录运行 `npm run plugin:pack` 生成压缩包与校验文件，再运行 `npm run plugin:check` 核对包内文件、权限和宿主能力声明。
