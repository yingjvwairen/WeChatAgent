# 达妮娅微信原生语音适配评估

首次评估日期：2026-10-25；当前实现状态更新于 2026-10-26。目标是让微信联系人收到可直接播放的原生语音气泡，并支持以后更换音色。音频文件附件与 DSH 本机朗读均不作为替代方案。

**当前状态：对象多选、模型方案切换、文字/原生语音回复选择、持久队列与独立 Qt 输入组件已经接入。旧受控预览的达妮娅短句已收到真实语音回执，并获用户手机确认“完整流畅”；新版低层 Qt 单字发送也取得文字回执。新多好友完整自动回复链路和副机尚未完成实机验收。**

当前操作入口及部署要求以 [机器人控制与副机部署](BOT_CONTROLS_AND_SECONDARY_SETUP.md)、[DSH 本地运行](DSH_LOCAL_RUNTIME.md) 为准。新语音队列按真实音频时长拆分不超过约 7.5 秒的气泡，固定单条回复的模型方案，按段核对回执；未知结果只查询、不重新录制。副机预先配置虚拟音频线路，正式发送器不修改默认录音设备。

下方按倒序保留开发阶段的实测记录与原始评估。其中“尚未接入”“待实现”和早期默认音频切换等措辞描述对应历史阶段，不代表上述当前实现。

文字侧已在 DSH 独立运行环境完成已知草稿核验、中文/英文/表情逐字追加及鼠标打断，并在用户授权后向文件传输助手提交了一次文字消息，取得真实数据库确认回执。同一发送 ID 再次调用没有重发，发送后输入框为空。文字回执不代表手机已读；语音新增结果及剩余限制见下文和 [微信界面操作说明](WECHAT_UI_AUTOMATION.md)。

## 第七阶段：原生计时执行与真实语音回执

用户授权范围仍仅为文件传输助手。第三轮输入为 4560 毫秒达妮娅 WAV，同一原生宿主串起录音、实际 CABLE 捕获会话核验、播放结束和语音提交，避免开发工具分步等待。程序播放耗时 5031 毫秒，数据库记录的语音时长为 5560 毫秒，微信显示 6 秒；5891 毫秒的录音执行耗时包含结束状态观察，不用它代替语音实际时长。报告确认捕获绑定、播放完成、提交输入及录音结束，`recordingPossible: false`；私有 Reader 取得新增、唯一、完整绑定的原生语音记录回执，`confirmed: true`。

用户手机试听反馈内容完整，但有卡顿或停顿。随后第四轮把音频渲染、PCM 与播放资源移至专用 MTA 线程，同一 4560 毫秒 WAV 的排空耗时降至 4594 毫秒；数据库语音为 5160 毫秒，微信显示 5 秒，回执确认成功。用户仍反馈一点卡顿，声音连贯性尚未通过。线程已停止并回收，最大填充间隔为 17.103 毫秒；`paddingStarvationCount: 161` 是源数据未写完时队列零值的风险采样，不等于 161 次实际丢音。数据库回执不比较音频内容或音色，相关字段仍为 `false`；主观试听与数据库证据分别记录。

第五轮在该播放线程内临时成对申请/释放 1 毫秒计时分辨率，先通过仅 CABLE 调度检查，再重复同一句微信测试。原 WAV 为 4560 毫秒，程序排空耗时 4546 毫秒，数据库语音为 5080 毫秒，微信显示 5 秒；用户手机确认“这次完整流畅”。最大填充间隔为 7.114 毫秒，队列零值风险采样为 10 次；该计数不是实际丢音次数。实际捕获会话、提交及录音结束均确认，线程停止并回收，计时请求已恢复，录音与恢复屏障均解除。临时 Reader 已停止、清理状态明确，DSH 环境无 `CODEX*` 变量，UGREEN 默认录音设备也已恢复。通过范围为本机这条受控短句，不能据此承诺其它音频或无人值守运行。

成功运行使用 DSH Node/Python 且无 `CODEX*` 环境变量，Reader 已停止并清理临时目录，普通/多媒体/通信默认录音设备恢复原 UGREEN。结果在忽略的 `state/diagnostics/timed-voice-live-result.json`。前两次起录因输入归属检查中止，未播放或提交，并已取消；随后仅移动鼠标的实测确认旧 64 位标记的回传值仅低 32 位匹配，改为发送非零 32 位标记后完整匹配通过。自身事件仍需注入标志加完整标记相等，人工优先规则没有放宽。

同一语音发送 ID 再次调用已实测返回 `reused: true`、`confirmed: true`，没有再次校准、录音或发送，原生尝试文件逐字节未变。首次成功和复用结果另存在本机 `timed-voice-third-first-submit-result.json` 与 `timed-voice-third-reuse-result.json`，不随公开源码分发。

新增 `timed-voice-preview.mjs` 的真实单次执行器、`ui-voice-preview-submit.mjs` 的持久尝试编排和 `ui-voice-reader-receipts.mjs` 的语音记录回执。未知录音状态会保留屏障，同 ID 不重录，不能通过换 ID 绕开。原生音频上限 8 秒、外层测试编排上限 5 秒；12 秒录音预算和 18 秒进程看门狗均为开发限制，不是微信的实测上限。真正播放中的人工打断、生产队列、通用账号/聊天绑定及长期 Reader 服务仍待完成。

20:20（北京时间）的 DSH 完整回归快照共 539 项，538 通过、0 失败、1 跳过；16 项运行环境检查和 227 项原生自检通过，日志为 `state/logs/dsh-timed-voice-*`。后续兼容与音频调度修复分别补做受影响模块测试，最终语音原生自检 41 项、语音 Node 测试 10 项、提交编排 14 项及文字宿主相关测试 31 项通过；没有将后续修改重新计入早先全套快照，也不以离线测试代替手机试听。

## 第六阶段：文字单次提交已验证（原生计时执行之前）

文字路径新增 `account-probe.mjs` 的私有临时账号进程旁证、`withLocalReceiptApi()` 的限时回执会话，以及 `ui-submit-preview.mjs` 的持久单次提交编排。只有文件传输助手和具体正文哈希获得显式授权后才准备回执基线并执行一次校准按钮点击。点击结果未知不重发；真实新增、唯一且绑定完整账号、目标、正文和服务器 ID 的回执才确认。临时 Reader 和目录已清理，结果为 `readerSessionStopped: true`、`cleanupUnknown: false`；仍保持 `ready: false`、`unattendedReady: false`。

用户当前授权文字和语音开发测试，范围均限文件传输助手。文字路径的验证没有解决语音自动录制：下一步仍需在同一原生宿主内串起录音、实际 CABLE 捕获证据、播放结束后的及时提交与人工打断，避免此前 4.56 秒音频因分步操作形成 32 秒气泡。语音状态机、播放器与文字回执不能直接冒充真实语音执行和送达证明。

2026-10-25 19:54（北京时间）的单次文字提交快照全套回归共 510 项，509 通过、0 失败、1 跳过；14 项独立运行检查和合计 202 项原生自检通过。日志为忽略的 `state/logs/dsh-single-submit-tests.log` 与 `dsh-single-submit-check.json`。这一快照不覆盖之后新增的语音驱动，历史语音实机证据仍是下文两次原生气泡及手机试听。

## 第五阶段：持久发送连接与首次读取配置

新增独立 `ui-onebot.mjs` 入口、`durable-ui-v1` 发送协议及 `ui-reader-receipts.mjs` 文字回执：DSH 桥接可以区分已排队、等待人工操作结束、已提交与已确认送达，超时和重启后查询同一任务，不把排队当作发送成功。反向 WebSocket 与桥接适配器的本机端到端测试已通过，界面和数据库使用测试替身；本阶段没有发送新的真实微信消息。生产启动管理尚未切换至这一后端，原生语音仍未接入自动回复链路。

首次消息读取所需的隔离 Python 环境、固定版本读取组件和本机账号目录发现已准备。首次等待登录超时后，用户在第二轮助手就绪时手动重新登录；消息与联系人数据库验证通过，凭据已用 Windows 当前用户加密保存。随后以临时独立配置实际运行 Reader，并完成仅限文件传输助手的最近 30 秒精确回执查询，完整窗口为 0 条；没有打印聊天内容或开启监听服务。这一历史步骤验证读取和空窗口处理，不是新消息送达测试；实际文字新增回执在第六阶段才通过。读取到数据库始终不等于当前桌面账号或唯一聊天身份已验证。最新入口、验证记录与待完成事项见 [DSH 本地运行说明](DSH_LOCAL_RUNTIME.md)。

## 第四阶段：脱离开发工具的运行入口

用户已明确要求最终在 DSH 环境使用，截图、输入和语音不能借助 Codex。现已提供 `scripts/ui-runtime.ps1`，显式使用 DSH 的 Node/Python，项目原生执行器使用 Windows 系统能力。移除开发工具环境变量和路径后，运行时检查通过；在这一入口下实际启动模型、合成新的 5 秒 WAV，并正常停止服务。本次仅本地合成，未新增微信消息。

新增 `scripts/ui-voice-session.mjs` 提供持久语音状态机，24 项离线测试覆盖打断、实际捕获设备校验及不确定提交不重发。它仍需真实界面驱动、原生录音看门狗和送达回执，默认禁止开始录音；55 秒为开发预算，不是微信录音时限的实测结论。已确认取消的任务不自动重录。

配置、截图独立验证、参数传递与交付缺口统一见 [DSH 本地运行说明](DSH_LOCAL_RUNTIME.md)。本机新入口使用 DSH Node 24.21.0、Python 3.12.14；下文旧版运行时和“未安装模型”描述为各历史阶段记录。

## 第三阶段：原生语音测试通过

用户明确取消了前次测试问题中的 3 秒限制，继续授权仅在文件传输助手测试。2026-10-25 已实际发送一条显示为 **24 秒**的原生语音消息：其中包含 1.2 秒测试音数据（997 Hz 和 1499 Hz 两段短音），其余为分步操作等待产生的静音。用户随后在手机微信完整试听，并确认能听到两声提示音。

录音进行时，WASAPI 会话查询确认微信主进程拥有状态为 active、singleProcess 的 CABLE Output 录音会话。结合手机试听确认，这次结果超出了仅检查系统默认设备或看到发送气泡的验证范围；它证明本机本次测试音已被微信录入并通过原生消息送达手机。

测试后普通及通信默认录音设备均已恢复原 UGREEN 麦克风并复核。尚未实测自动发送时的人工打断、目标切换、断网、重启或语音回执匹配；24 秒是本次分步测试时长，不是播放器性能或微信时长上限。以下第二阶段记录是该次发送之前的历史结果。

随后安装并启动独立达妮娅环境，实际合成“你好，我是达妮娅，这是微信语音测试。”，返回 **4.56 秒、32 kHz、PCM16、单声道** WAV；此轮合成命令耗时约 4.2 秒。经新播放器输出至 CABLE，实际播放约 4545 毫秒，再由微信发送为一条 **32 秒原生语音气泡**（含分步操作的前后静音）。录音时再次查到微信使用 CABLE Output；用户在手机试听后确认“完整清晰，音色也符合预期”。

两次受控发送均只发生在文件传输助手。第二次测试结束后也已复核两个默认录音角色均恢复原麦克风；模型服务正常停止，监听端口及本次启动的子进程均已退出，GPU 不再保留该模型进程。完整本机证据在忽略的 `state/dania-voice/verification.json`，合成样本在 `state/voice-preview/`。

### 独立模型环境与复现

本机环境位于 `state/dania-voice/`，不修改用户的 DSH 插件。新增 `scripts/dania-setup.py` 固定引擎源码与模型版本，校验下载文件；完整依赖快照保存在 `installed-requirements.txt`。模型使用 CUDA，API 仅监听 `127.0.0.1:9880`。第一次合成因缺少 G2PW 中文多音字资源超时，已将固定版本及哈希的 G2PW、FastText 等资源加入离线准备和启动前检查，修复后真实合成通过。

首次安装使用 Python 3.12，按下列顺序准备；需要下载代理时，在对应 setup 命令后加 `--proxy <本机代理地址>`，只影响该次安装进程。

```powershell
python scripts/dania-setup.py --stage dependencies
python scripts/dania-setup.py --stage models
python scripts/dania-setup.py --stage resources
python scripts/dania-setup.py --stage configure
python scripts/dania-setup.py --stage check
node scripts/dania-start.mjs
```

本机已经完成安装，后续使用可直接运行启动命令。启动终端保持运行，看到 API ready 后再在另一终端合成；正常停止按 Ctrl+C。已验证正常停止会退出 venv 启动器和实际模型进程，不能据此承诺强杀守护进程也能完成所有清理。

新增 `scripts/voice-preview.mjs`，用于调用本地合成服务，将经过 WAV 校验的片段和哈希清单保存到忽略的 `state/voice-preview/`。它不播放或发送音频，清单不包含输入文本；实际音频仍包含合成内容，应留在本地。

```powershell
node scripts/voice-preview.mjs synthesize --config state/dania-voice/config.json --text "你好，这是达妮娅语音测试。"
```

上面的命令需要已准备并启动的本地模型服务，配置中的音色名本身不能证明服务加载了对应模型。

`scripts/cable-player.mjs` 提供 `CablePlayer`：只能向枚举后明确选择的 VB-CABLE 端点播放，支持常见采样率的 PCM16/float32 单、双声道 WAV。每个实例串行接受播放，支持 `AbortSignal`、`stop()` 和 `close()`；取消后等待原生子进程退出，无法确认停止时拒绝后续播放。父进程管道关闭也会停止原生播放器，不会回退到物理扬声器。60 秒与 32 MiB 是播放器自己的限制，未用它们推定微信的录音限制。

正常完成、错误和受控取消会清理临时 WAV；父进程被强杀或崩溃可能留下临时文件，尚未提供崩溃清扫。播放成功仅代表音频已输出到指定设备，不等于微信录入或发送成功。

新增合成预览和播放器后，全套测试共 354 项，353 通过、0 失败、1 跳过；原生音频自检增加至 34 项。日志为忽略的 `state/logs/voice-integration-tests.log`。

## 前期核查依据

- [微信官方 Windows 4.1.9 更新日志](https://weixin.qq.com/updates?platform=windows&version=4.1.9)（2026-04-21）明确列出“可发送语音消息”。本机 4.1.15.56 已验证录音入口、点击“×”取消及测试语音提交；缺少 Hook 接口不等于客户端没有原生语音功能。
- 本机已有状态正常的 `CABLE Input (VB-Audio Virtual Cable)` 和 `CABLE Output (VB-Audio Virtual Cable)`，两端之间的实际环回也已验证通过。此结果不能证明微信已经录入或发送测试声音。
- [VB-CABLE 官方说明](https://vb-audio.com/Cable/)确认播放端的音频会转发至录音端。拟将合成器输出定向播放到 CABLE Input，由微信从 CABLE Output 录入；声音完整性、受控录制时长及人工打断仍需实测。
- 界面控件不可读时，改用窗口截图、文字识别及图标定位进行适配。识别不确定、目标不唯一或无法核对草稿时停止，保留现有人工优先队列。

## 第二阶段验证结果

以下为第三阶段实际发送之前的记录。

新增 `scripts/native-audio/AudioRouteProbe.cs`、构建脚本和测试。默认只列设备，显式指定唯一 VB-CABLE 端点才允许播放测试信号或进行环回验证；不会回退到物理麦克风或扬声器，不修改默认设备。捕获数据只在内存分析，不保存录音文件。

本机实际环回验证通过：48 kHz、双声道浮点格式，约 2910 毫秒采样中识别到预设 997 Hz 和 1499 Hz 双频信号，未发现中断。单独的短音播放命令也已通过，1200 毫秒的测试数据约 1196 毫秒完成。这验证了本机虚拟音频设备链路，**不能视为微信已录入或送达**。

微信文件传输助手已验证一次“开始录音 → 点击可见 × 取消”，取消后没有新增消息。操作前临时将普通及通信默认录音设备都切换到 CABLE Output，结束后均恢复原 UGREEN 麦克风并复核。用户已允许发送不超过 3 秒的测试音，但当前分步操作无法保证录音时长不超限，因此本轮未提交语音，尚未验证原生气泡或接收端播放。取消后查询微信进程的录音会话未发现保留记录；会话缺失不能用于推断其先前使用的录音设备，也不能用系统默认设备代替微信实际录入验证。

聊天身份识别也仍未通过：临时切换浅色外观后，Windows OCR 和 RapidOCR 中模型仍未精确匹配标题；RapidOCR 可定位“搜索”和“发送”，但诊断保持 `ready: false`。检查结束已恢复“跟随系统”外观并截图确认。

原生音频诊断通过 22 项自检。第二阶段全套测试共 337 项，336 通过、0 失败、1 跳过，日志为忽略的 `state/logs/development-media-tests.log`。仍未实测真实微信文字输入、人工打断或消息送达。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-audio-probe.ps1 -SelfTest
node scripts/ui-preview.mjs audio-devices
# 两端 ID 必须来自上述真实枚举，不能使用默认设备占位符：
.\state\audio-probe\AudioRouteProbe.exe --probe --render-id <播放端ID> --capture-id <录音端ID>
# 仅播放 1.2 秒短音，不操作微信，也不录音：
.\state\audio-probe\AudioRouteProbe.exe --play-test --render-id <播放端ID>
# 仅查询指定进程的录音会话元数据，不采集音频：
.\state\audio-probe\AudioRouteProbe.exe --capture-sessions --pid <微信进程ID>
```

项目尚未配置达妮娅模型环境，默认目录未发现模型或参考音频，默认端口也没有监听服务。已核实本机有 Python 3.12 和合适的 NVIDIA 显卡，可后续隔离安装在 `state/`。上游安装器的显式 `DANIA_PYTHON` 分支返回值与调用处不一致，需要先修复或用仅对子进程生效的 PATH 处理，不能直接套用该变量运行。此轮未下载达妮娅模型或更改用户 DSH 插件。

后续开发遵循[微信界面操作与人工优先方案](WECHAT_UI_AUTOMATION.md)。下文的 Hook 路由与 SILK 链路说明已有实现的缺口，不代表已经决定继续采用后台 Hook 发送；界面录音路径若可行，应单独验证，而非沿用未验证的底层假设。

## 源码基线

| 项目 | 核验提交 | 用途 |
| --- | --- | --- |
| [WeChatAgent](https://github.com/sourcepro5/WeChatAgent) | `34766b6f52e8e87c09dff8ad19dc62c39700aa4d`，0.4.0 | 主项目，已拉取并保留 Git 历史 |
| [dsh-dania-voice](https://github.com/xcw520/dsh-dania-voice) | `27b29c16ad0950b629823830ed7600078b40d4d9`，1.0.2 | 达妮娅合成及安装流程参考 |
| [WeChat-Hook](https://github.com/aixed/WeChat-Hook/tree/e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6) | `e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6` | 主项目构建脚本锁定的上游 |

主项目本地开发分支为 `feat/dania-voice`。首次拉取阶段准备了依赖和评估；随后新增独立语音客户端、界面输入预览及第二阶段诊断。第三阶段已准备隔离模型环境，并完成测试音及达妮娅短句的微信原生语音发送；机器人运行入口仍未改变，也未注入 Hook。

## 已实现的合成客户端

`scripts/voice-synthesis.mjs` 已提供 `resolveDaniaConfig`、`VoiceSynthesisClient`、`splitVoiceText` 与 `inspectWav`。实现配置发现、默认达妮娅参数、按最多 90 个码点分段且不拆组合字符、跨调用串行合成、取消、完整响应超时、大小限制和 WAV 结构检查。超长文本报错，不静默截断；只返回音频数据及实际时长，不播放或发送。

```js
import { resolveDaniaConfig, VoiceSynthesisClient } from './scripts/voice-synthesis.mjs';
const client = new VoiceSynthesisClient({ config: resolveDaniaConfig() });
const result = await client.synthesize('需要合成的文字');
// result.segments[].audio 是经过检查的 WAV Buffer。
// 这一步需要已有本地 GPT-SoVITS 服务；不会自动安装或启动模型。
```

`node --test scripts/test-voice-synthesis.mjs` 的 12 项测试已通过，使用本地模拟 HTTP 服务验证参数、串行、错误及音频校验，不依赖实际达妮娅模型。模型权重只按调用方配置标识，结果明确返回 `modelVerification: 'caller-configured'`，不能视为已经核验外部服务加载的模型。

## 已核验的能力边界

| 层次 | 当前情况 | 证据 |
| --- | --- | --- |
| 达妮娅合成 | 调用本机 GPT-SoVITS `/tts` 返回 WAV，DSH 界面播放 | [dsh-dania-voice/index.js](https://github.com/xcw520/dsh-dania-voice/blob/27b29c16ad0950b629823830ed7600078b40d4d9/index.js#L560) |
| 历史原生发送适配 | 该发送器已退役 | 当前发送方式见[日常使用](DAILY_USE.md)。 |
| 上游 Hook | 发送声明只有图片、文字和图片解码；路由没有语音 | [wx_send.h](https://github.com/aixed/WeChat-Hook/blob/e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6/include/wx_send.h)、[http_routes.cpp](https://github.com/aixed/WeChat-Hook/blob/e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6/src/http_routes.cpp) |
| XML 转发 | 仅识别图片、视频和表情，其余类型直接失败，不能直接拼语音 XML 复用 | [wx_send_xml.cpp](https://github.com/aixed/WeChat-Hook/blob/e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6/src/wx_send_xml.cpp#L522) |
| OneBot 适配 | 现有输出仅文字及专用表情分支，不支持 `record` | [hook-onebot.mjs](../scripts/hook-onebot.mjs)，`textSegments`、`action` |
| 消息回执 | 消息查询可返回语音基础记录，但没有语音专用元数据提取及发送回执匹配逻辑，尚不能可靠关联并确认本次语音提交；实时推送入口不接收语音 | [reader-api.py](../scripts/reader-api.py)，消息查询与推送入口 |

[build-hook.ps1](../scripts/build-hook.ps1) 会用本项目路由覆盖上游路由，但上游本身也没有可恢复的语音发送入口。因此这里不是打开一个已有开关，也不能通过把 WAV 改名为 SILK 或把文件消息改成类型 34 完成。

## 优先验证的界面录音链路

```text
已清理的回复文本
  → 达妮娅 GPT-SoVITS 合成 WAV
  → 校验音频及实际时长，播放至指定虚拟音频设备
  → 微信原生录音入口录入，再通过界面发送
  → 确认新的语音消息及送达状态
  → 接收方设备显示原生气泡且实际可播放
```

上述路径由微信负责音频编码和上传，不要求机器人自行构造语音协议。录音需要消耗音频的实际播放时长；长回复必须根据实测录音限制分段。人工活动中断时，停止音频并进入待处理状态，取消界面操作也必须重新确认焦点和目标，不能在用户已经切换应用后盲目按发送或取消快捷键。

仅当以后另行选择协议发送后端时，才需要评估 SILK 编码（例如 [silk-wasm](https://github.com/idranme/silk-wasm)）与原生上传结构；这些不属于目前优先的界面录音方案。测试音和达妮娅短句的录音、发送与手机播放已通过，当前仍需完成自动执行的适配。

## 达妮娅接入约定

- 本地接口默认 `POST http://127.0.0.1:9880/tts`，请求指定 `media_type: "wav"`、`streaming_mode: false`，成功响应为音频字节。
- 插件配置位于 `$DSH_HOME/dania-voice/config.json`；未设置 `DSH_HOME` 时使用用户目录下的 `.dsh/dania-voice/config.json`。`installDir` 只改变引擎安装目录，不改变这个配置发现位置。
- 引擎默认位于 `<installDir>/gpt-sovits`，Python 位于 `<installDir>/venv/Scripts/python.exe`。启动时以引擎目录为工作目录，执行 `api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`。
- 模型为 `GPT_SoVITS/dania-e15.ckpt` 和 `GPT_SoVITS/dania_e16_s2192.pth`；参考音频为 `output/slicer_opt/output.wav_0009342720_0009558400.wav`。这些路径相对于引擎目录。参考文本和推理参数应读取插件配置，不另行猜测。
- 原插件按最多 90 字分段并串行合成。微信气泡应按生成音频的真实时长再做长度约束，不能用字数直接推定可发送时长。
- 更换音色通常要一起更换模型权重、参考音频、参考文本及语言。GPT-SoVITS 的权重切换影响同一个服务实例的全局状态；多个聊天使用不同音色时，宜用独立实例，或将权重切换与合成放入同一串行队列。

实现独立客户端时，应验证完整响应的超时、状态码、WAV 格式和大小；缓存键包含模型、音色及采样参数；合成失败应有明确状态，不能记录为已发送。

## 建议开发顺序和验收条件

1. **完成原生发送验证。** 录音入口、一次取消和独立虚拟音频环回已通过；下一步验证已知短音能否录入微信，并成为接收设备上可播放、时长正确的原生语音气泡。测试对象及实际发送遵循用户已明确指定的范围。界面路径未通过时保留能力缺口，不自动切回 Hook 或附件方案。
2. **接入发送及回执。** 对已验证的发送方式增加能力探测，保留账号、客户端兼容性和聊天允许范围检查，并实现人工操作暂停；补充语音回执提取、发送前落盘、幂等标识、超时状态及重启恢复。提交结果不确定时不得自动重复发送。
3. **接入合成和音色配置。** 新增达妮娅提供方、音色预设、总开关及单聊覆盖；普通聊天和助手最终回复可以按配置发语音，任务进度、审批和控制命令单独处理。禁用时保留现有文字行为。
4. **端到端验收。** 验证短句、长句分段、中英混读、私聊和群聊、合成超时、断网、重复请求、重启和权限撤销。验收以接收设备的气泡及播放结果为准，不能以 HTTP 成功或本地缓存文件代替。

当前继续完成第 1 步的录入与发送验证。若只能发送音频附件，就未达到本需求，不能静默降级或标记完成。

## 本地准备及验证结果

- Node.js 为 `24.19.0`，满足项目 `>=22.13.0` 的要求。
- 已按锁文件安装根目录及 DSH 桥接插件的 npm 依赖，使用 `--ignore-scripts`；Electron 运行时及完整安装包尚未构建。当前终端没有独立 npm 命令，本轮将 npm 11.6.2 放在忽略的 `state/tools/npm/package` 下，可用 `node state/tools/npm/package/bin/npm-cli.js <命令>` 执行。
- 原始代码基线测试为 281 项，280 通过、0 失败、1 跳过。跳过项为需要 NSIS 编译缓存的安装目录编译测试；第二阶段仍保留此跳过项。此结果不是语音功能验收。
- 第一阶段代码及复核修复加入后再次运行全套测试：324 项，323 通过、0 失败、1 跳过；跳过原因同上。Windows 执行器已编译并通过 20 项无界面自检，离线演示的 6 项检查通过。上述验证未操作真实微信，也不代表原生语音已验收。
- 最新第二阶段全套测试为 337 项，336 通过、0 失败、1 跳过，见 `state/logs/development-media-tests.log`；原始基线日志保留在 `state/logs/baseline-tests.log`。两者均被版本控制忽略。
- 已运行 `node scripts/public-source-check.mjs`，未发现违规文件或凭据特征。
- 本机检测到 RTX 4070 Ti，显存约 12 GB，达到达妮娅项目推荐的 NVIDIA 8 GB 以上配置；尚未进行本机合成性能实测。
- 本机已发现的微信程序版本为 `4.1.15.56`，而主项目锁定 `4.1.10.27`。未更换当前微信。源码目录也未准备匹配客户端、原生 Hook 编译产物及数据库自动连接组件；拉取源码不等于完整机器人已能运行。

关于第三方素材，达妮娅插件代码采用 MIT，[模型下载仓库的 README](https://www.modelscope.cn/models/villia/dania/resolve/master/README.md) 标注 Apache License 2.0；若以后复制或分发内容，应分别保留对应许可。后端适配不需要复制插件立绘。微信与语音组件的来源见 [LICENSES.md](../LICENSES.md)。
