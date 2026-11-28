# 本机 faster-whisper 单条语音识别

微信语音可以在这台 Windows 电脑上用 CPU 转写。模型加载后常驻内存，独立的「语音识别 API」和「语音对话 API」都能通过已有的文件转写接口使用它。聊天、人格和发送方式沿用当前配置。

## 准备模型和环境

在项目目录打开 PowerShell。已有可用的 faster-whisper 环境和 CTranslate2 模型目录时，可以沿用原环境和权重。全新环境可使用以下命令。下载依赖与模型需要网络，运行转写使用本地文件。

```powershell
npm run media:prepare -- --model small
npm run media:check -- --model small
$asrPython = '.\state\local-whisper\venv\Scripts\python.exe'
```

可选 tiny、base 或 small，文件逐项校验固定版本的摘要。准备和检查都会用当前权重转写一段内置短句。已有环境和权重可通过 `--python`、`--model-directory` 指定，`media:check` 完全离线。Small 权重约需 484 MB 磁盘。也可将以下命令中的模型目录指向自己准备的 CTranslate2 权重。

Windows 本地识别进程默认使用 `CT2_USE_MKL=0` 和 `OMP_NUM_THREADS=1`，减少加载 Small 权重时的内存占用。运行环境显式设置的值优先。

## 自动预热与插件连接

在桌面应用的“本地语音服务与模型方案”里启用识别，选择 Python 和本机模型目录并保存。应用打开后即在后台预热，不必先启动机器人。首次使用的默认方案直接跟随这里的模型目录。通过界面保存的具名方案写入 `state/local-speech/asr.profiles.json`，各方案此后使用自己保存的路径、语言和提示词。

点击“保存并使用”会立即加载选定模型，完成后才显示就绪；切换不等待下一条消息。相同权重只改变语言或词表时复用模型，并清除旧的短期转写缓存。插件模型填 `default` 跟随界面选择，显式模型 ID 则固定使用该方案。

桌面和独立机器人共同持有后台服务。使用者全部退出或失联时，程序会释放本项目拥有的模型。已获聊天授权的识别路线全部改为云端时，后台也会释放本机 Whisper。仍有聊天使用本机识别时会保留服务。云端期间可以保存并选定本机方案，切回本机识别时会自动加载。预热不增加任何聊天的语音识别授权。

## 可选的独立启动

托管模式无需以下手动命令。独立运行时：

```powershell
& $asrPython -I -B scripts\local-whisper.py --model-dir state\local-whisper\models\small
```

看到服务启动后保持窗口打开。在「语音识别 API」里选择「本机语音服务」，填写地址 `http://127.0.0.1:8000/v1`、模型 `default` 和密钥。首次启动会生成私有文件 `state/local-whisper/api.key`，把其中的一行复制到插件的 API 密钥栏。服务固定监听本机，端口可通过 `--port` 修改。

使用「语音对话 API」时，在「单条语音识别」中选择文件转写、自定义 OpenAI 兼容协议和 Bearer 鉴权，填写相同地址、模型和密钥。语音合成可继续使用单独选择的提供方。为聊天授权一个单条识别提供方后，用设置页的内置短句检查服务连接，再在对应聊天中查看收到的语音转写。

按 Ctrl+C 停止服务并释放模型。服务处理单声道 PCM16 WAV，最长 60 秒；它只向插件返回转写文本。原始音频、提示词、转写文本和密钥均不写入服务日志。

## 识别方案、语言和词表

可以在 `state/local-whisper/profiles.json` 保存多个识别方案。`modelDirectory` 相对于此文件解析，也可以填写本机绝对路径。`language` 留空时模型自动检测语言；`initialPrompt` 可以放人名或专用词。托管模式可在界面保存后点击“保存并使用”即时应用；独立手动进程没有启用管理接口时，编辑 JSON 后重新启动。

```json
{
  "auto": {"modelDirectory": "models/small"},
  "chinese": {"modelDirectory": "models/small", "language": "zh", "initialPrompt": "语音识别，文件传输助手"}
}
```

```powershell
& $asrPython -I -B scripts\local-whisper.py --profiles state\local-whisper\profiles.json
```

托管服务启动时预加载上次选中的方案，独立服务默认预加载第一项。插件可以通过「读取模型」选择 `auto` 或 `chinese`。指向相同权重的方案复用内存中的模型。界面点击使用会立即加载另一份权重；插件直接请求具体方案 ID 时也可切换。插件中的显式语言参数优先于方案语言。

托管端口默认为 8000，可在本地语音设置中更改；插件地址使用界面显示的实际端口。解释器或启动配置与另一个仍在运行的使用者不一致时会明确报告冲突，停止旧使用者后再应用。
