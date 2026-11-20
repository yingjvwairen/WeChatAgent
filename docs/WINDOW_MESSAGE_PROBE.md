# 非注入窗口消息诊断

这是独立诊断工具，不是自动发送后端。鼠标消息目前仅允许两个已标定位置：打开自身资料卡 `self-profile-open`、聚焦左侧搜索框 `search-focus`。不允许发送按钮、录音、任意坐标或任意窗口消息，不接入自动回复。另有只读窗口图像诊断；该 PNG 可能包含当前聊天文字，仅保存在本机。

`scripts/native-ui/WechatWindowMessageProbe.cs` 只向精确绑定的微信主窗口投递 `WM_MOUSEMOVE`、`WM_LBUTTONDOWN`、`WM_LBUTTONUP`。它不激活微信，不移动系统鼠标，不发送全局按键，不访问剪贴板，不连接输入队列，也不向微信加载或写入代码。投递被 Windows 接受不能证明微信处理了点击；必须另行检查实际界面。

## 构建和只读阶段

```powershell
./scripts/build-window-message-probe.ps1 -SelfTest
node ./scripts/window-message-probe.mjs --hwnd <当前十进制句柄> --scope self-profile-open --mode inspect
node ./scripts/window-message-probe.mjs --hwnd <当前十进制句柄> --scope search-focus --mode prepare
```

`node` 可替换为本机 DSH 自带 Node 的完整路径。两种模式都不投递消息。默认是 `inspect`，每次结果和请求保存在本机 `state/diagnostics/window-message-*.json`。

配置使用现有 `state/ui-runtime/qt-visual.json` 的程序路径、版本、SHA256、尺寸、DPI、空闲门槛和标定区域。当前仅接受微信 `4.1.15.56`、`Weixin.exe` 与 `Qt51514QWindowIcon`。程序同时查询真实进程路径和创建时间，拒绝已重用的 HWND、跨会话窗口、锁屏、最小化、禁用或不可见窗口。

准备阶段另外检查前台句柄、系统光标、最后输入时间和按键状态。不会为了通过检查而等待用户停止操作，也不会改变焦点。

## 只读窗口图像

```powershell
node ./scripts/window-message-probe.mjs --hwnd <当前十进制句柄> --scope search-focus --mode capture
```

该模式仅调用 `PrintWindow`，参数为客户端区域及完整内容标志（数值 `3`）；不投递鼠标消息，不申请前台，不访问剪贴板或全局按键，也不回退为物理屏幕截取。`scope` 仍须是现有的两种已标定范围之一，它在此模式只是限定绑定配置，不触发对应点击。原生直接调用的 JSON 还需 `imagePath`，指向尚不存在且父目录存在的本地 `.png` 文件。

抓图前核验程序文件版本、SHA256 和配置摘要；抓图前后重新检查同一窗口、PID、进程创建时间、实际程序路径、客户端/屏幕几何和 DPI。返回的版本及程序摘要来自这次调用前的构建核验，不能把它们理解为抓图结束后重新计算了文件摘要。最小化、锁屏、窗口不可见或失效时拒绝。允许的负屏幕坐标不自动表示离屏，也不能因此推定为副屏。前台句柄、物理光标和系统最后输入时间分别记录为观察值；活动变化会明确体现在结果中，不能被解释为机器人已取得输入权。

结果包含图片绝对路径、PNG 的 `imageSha256`、原客户端尺寸、前后状态和采样颜色数量。`PrintWindow` 成功或得到非黑图只说明画面被绘制；不能证明内容实时、没有遗漏的弹窗、对应最新联系人、消息已经发出或账号已确认。`contentVerified`、`eligibleForAutomation` 和 `retryAllowed` 始终为 `false`，`inputSent` 与 `livePostMessageCalled` 也为 `false`。颜色数不是识别结论。

原生进程设有 10 秒超时，包装器另有 12 秒上限，取消信号会终止子进程。超时或取消后不自动重试，也不从可能残留的 PNG 推断成功。文件和请求均属于本机诊断资料。

若未来接入正式流程，最小用途是获取焦点前的只读诊断或提前拒绝明显不满足条件的环境。后台图像的正向结果仍须经过所选正式模式的当前窗口、账号旁证与数据库目标绑定，才能执行操作；共享自适应私聊优先搜索公开微信号，缺少时仅用当前数据库中唯一的备注／昵称，内部稳定 ID 用于选择和回执，不增加界面身份核验或读回。普通模式保留资料和草稿核验。当前没有把此模式接入正式发送权限判断；也没有因此启用离屏点击或原生语音后台发送。

## 单次受限实测

仅在操作者已经检查当前界面、停止其他项目输入执行器后，才显式执行：

```powershell
node ./scripts/window-message-probe.mjs --hwnd <当前十进制句柄> --scope self-profile-open --mode execute --enable-pointer-messages
```

包装器依次检查、准备和投递一次消息序列。原生入口还校验准备快照不超过 5 秒，并取得项目统一输入互斥锁。未加显式开关时，执行模式会在访问桌面前拒绝。

结果分别报告前台是否变化、物理鼠标是否变化、系统输入时间是否变化、三条消息是否都进入队列。`clickConfirmed` 和 `eligibleForAutomation` 始终为 `false`，不自动重试。若按下后发生变化，会仅在目标身份和几何仍一致时补齐同一窗口的抬起消息；`unpairedDownQueued: true` 表示未能排队释放，不代表已经取消。未知结果必须重新观察，不能据此重复点击。

原生直接调用合同：初始 JSON 为 `{ "version": 1, "configPath": "配置绝对路径", "hwnd": "十进制句柄", "scope": "self-profile-open" }`；`--inspect --request <JSON>` 返回 `candidateRequest`，`--prepare` 接受该对象并返回 `preparedRequest`，`--execute` 接受后者并要求 `--enable-pointer-messages`。不要手工更改生成的身份、几何或用户状态字段。

离线检查覆盖范围限制、消息参数、禁止的消息、HWND/进程重用、版本和几何变化、用户活动、准备过期，以及按下后异常时的释放。另用内存中的合成位图测试 PNG 摘要、捕获结果不能变成发送权限、用户状态变化和 `capture` 不接受输入开关。测试使用模拟消息回调，不调用真实 `PostMessage` 或 `PrintWindow`。

```text
node --test scripts/test-window-message-probe.mjs
```

## 参考项目的实际实现

研究版本：[Luofeng-Cloud/WeChat-AI-AutoReply，5652f1c](https://github.com/Luofeng-Cloud/WeChat-AI-AutoReply/tree/5652f1cbf65c6a2011bf3329b22246eea4df6396)。没有启动其程序或安装其依赖。

| 代码位置 | 实际行为 |
| --- | --- |
| `wechat_ai_bot_dev.py:223` | `PrintWindow` 抓图，失败时可能回退物理截屏；文字来自 RapidOCR。没有 UIA 控件读取。 |
| `wechat_ai_bot_dev.py:298` | `AttachThreadInput`、置顶、`SetForegroundWindow` 等使微信取得前台。 |
| `wechat_ai_bot_dev.py:337` | 将鼠标消息投递给根窗口；物理指针不移动。 |
| `wechat_ai_bot_dev.py:844` | 保存纯文本剪贴板；随后写入回复文本。 |
| `wechat_ai_bot_dev.py:886` | 用全局 `keybd_event` 执行 Ctrl+V、Enter，然后恢复原前台。不是无焦点的后台键盘接口。 |
| `wechat_bot_gui_dev.py:770` | 用 `SetWindowPos` 移到 `(-3000,-3000)`；没有创建独立 Windows 桌面或虚拟机。 |

可借鉴的是定向鼠标消息和独立窗口抓图思路，不能直接采纳其“零封号”“键盘不被打断”“任意版本/遮挡均有效”等保证。当前源码没有给出这些保证的依据；也没有原生语音发送实现。

不复制其弱化身份和发送结果的处理：名称匹配允许 OCR 尾字缺失；绿色像素增量不是收件人和消息内容收据；未见绿色增量时会再次发送，可能重复；剪贴板只保存文本且恢复时不检查用户是否已经复制了新内容。这些均不能替代本项目的账号旁证、稳定目标绑定与数据库回执；共享模式的备注／昵称搜索须有当前数据库唯一映射，不能用模糊 OCR 名称匹配代替。

副屏提供额外可见空间，但仍共享同一套前台和键盘。负坐标也可能是合法副屏坐标，不能沿用参考项目的 `< -500` 判断为离屏；应按实际显示器矩形判断。是否支持遮挡或离屏绘制，需要独立、只读的 `PrintWindow` 验证，不能用返回非黑图片推定画面新鲜。双机方案继续保留。
