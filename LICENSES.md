# 许可证与来源（源码发布副本）

本目录是源码发布副本，不是本机运行目录的完整打包。根目录 LICENSE 保留原作者版权与许可文本，不能替代独立第三方依赖、桌面软件、模型服务和平台接口各自的授权。

| 内容 | 来源与范围 |
| --- | --- |
| Bridge 运行子集 | [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT；完整通知见 [组件 LICENSE](components/qq-bridge/LICENSE)；裁剪与修改说明见该目录 README |
| NT 数据库读取源码子集 | [zhuobichen/weflow-cli](https://github.com/zhuobichen/weflow-cli)，MIT；完整通知见 [组件 LICENSE](components/weflow-cli/LICENSE)；来源提交与修改范围见该目录 README |
| scripts/wechat_media.py | 同一 weflow-cli 来源版本中媒体辅助函数的复用，保留文件头来源说明和对应 MIT 通知 |
| scripts/wechat_sticker.py | 本项目新增绑定和下载逻辑；缓存布局及 CBC 约定参考同一 MIT 上游；账号派生公式另核对 [weflow-cli 25e0908 的 wechat_emoticon.py](https://github.com/zhuobichen/weflow-cli/blob/25e090803e8e2979b31137adfcfce60155334550/scripts/wechat_emoticon.py)，仅复用公式与本地文件候选，不包含其进程扫描实现；保留文件头来源与组件 MIT 通知 |
| imageio-ffmpeg | 独立安装的 Python 包，BSD-2-Clause；其 FFmpeg 程序按构建自带许可使用，本源码副本不分发二进制，见 [包元数据](https://pypi.org/project/imageio-ffmpeg/0.6.0/) |
| 本地语音转写依赖 | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 1.2.1（MIT）、[silk-python](https://github.com/synodriver/pysilk) 0.2.8（包元数据标注 BSD）、[PyAV](https://github.com/PyAV-Org/PyAV) 15.1.0（BSD-3-Clause）；运行时独立安装并保留各包许可，源码副本不分发 wheel 或编解码二进制 |
| 本地识别模型 | 独立下载的 [Systran/faster-whisper-small 固定修订](https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120)，模型、来源许可和使用条件以该项目为准；模型权重不包含在源码发行中 |
| 本地 OCR 模型 | 独立安装的 RapidOCR 3.10.0 及 [RapidAI/RapidOCR 模型固定修订](https://www.modelscope.cn/models/RapidAI/RapidOCR/files?Revision=d298462ac20a2e994f433151b5fe6cc1180e9a09)，固定模型摘要见 [部署说明](docs/LOCAL_OCR_RUNTIME.md)；来源许可与使用条件以该项目为准，源码副本不包含模型权重 |
| 微信后台无障碍控件树适配 | Qt accessibility gate 定位思路参考 [fanyuantaier/wechatauto-replica 的 accessibility.py](https://github.com/fanyuantaier/wechatauto-replica/blob/main/wechatauto/accessibility.py)（Apache-2.0）；本项目独立实现，未复制其代码，实际范围见 [后台控件适配](docs/BACKGROUND_CONTROLS.md) |
| 有权独立授权的本项目新增代码、桌面界面及已授权人格预设 | 依根目录许可的适用范围，不扩大到维护者无权授权的内容 |
| 安装时获取的 SDK 和 Python 包 | 各自原许可与依赖声明；副本不包含 node_modules 或解释器环境 |

来源记录见 [components.json](components.json)。原作者版权和完整许可文本保留，代码子集及修改范围单独标记。

## 独立准备的外部内容

- 维护者已确认当前使用组件的再分发授权。授权声明不替换上游自身许可。
- 原 WeFlow 与历史 WeFlowBackup 不包含在本目录中。今后引入其源码时，应保留原作者与 CC BY-NC-SA 4.0 许可，遵守适用的署名、非商业和改编共享条件。
- 微信、DSH 程序、原生预编译资源、第三方素材、截图、聊天及访问凭据不在源码发行范围内。五份已授权人格明确作为预设文件发布，用户安装后的账号配置和人格编辑不随源码分发。

公开可见不等于一般再分发许可，见 [GitHub 许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。本说明不是法律或平台授权保证，也不自动授予商标、账号数据或独立第三方内容的权利。

## Weather data services

Weather forecasts are fetched from [Open-Meteo](https://open-meteo.com/) and locations from its GeoNames-backed geocoding API. Data is provided under [CC BY 4.0](https://open-meteo.com/en/licence); source attribution is retained in the model evidence and links. The default public API is for personal/non-commercial use and subject to [Open-Meteo terms and request limits](https://open-meteo.com/en/terms). Commercial use requires a suitable provider subscription or a separately operated service. No provider source code is bundled.

网页正文提取使用 [htmlparser2 10.0.0](https://github.com/fb55/htmlparser2/tree/v10.0.0)（MIT）；锁文件固定依赖，安装包保留 htmlparser2、entities、domhandler、domutils 等各自的 LICENSE。网页工具的网络地址校验复用 MIT Bridge 的 safe-fetch 逻辑，来源许可见 `components/qq-bridge/LICENSE`。仅使用本机 DNS 解析；代理返回 Fake-IP 时按非公开地址拒绝，不向额外 DNS 服务发送网页域名。
