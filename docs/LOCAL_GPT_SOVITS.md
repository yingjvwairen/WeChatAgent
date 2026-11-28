# 本地 GPT-SoVITS 音色方案与权重预热

桌面应用的“本地语音服务与模型方案”可管理多个具名音色，扫描 GPT/SoVITS 权重与参考音频。启用本地合成后，桌面应用默认在后台预热上次选中的音色。插件模型名填 `default` 时跟随此选择。

同一工作区的聊天共享一个托管 GPT-SoVITS 进程。进程一次加载一套音色权重，使用其他已保存方案时切换权重。

已经在运行 GPT-SoVITS API v2 时，在语音对话插件选择“模型提供商 → GPT-SoVITS”，填写参考音频和对应文字，即可使用该实例已加载的权重。要在多套权重之间切换，可用项目的本机语音服务，并在插件的“自定义 API”中选取方案。

## 在新电脑准备达妮娅

在 Windows 源码目录使用 Python 3.12 运行下列命令。它将 GPT-SoVITS、CUDA 12.8 版 PyTorch、模型、语言资源和参考音频安装到项目的 `state/local-gpt-sovits`。模型文件按固定版本和 SHA-256 验证，下载中断后可以重新运行。

```powershell
py -3.12 scripts/prepare-local-gpt-sovits.py
```

准备完成后，把命令输出的 Python、模型目录和方案文件填入控制台的本地合成设置，选用 `dania`。已有模型环境可以直接填写原路径。需要单独准备某一步时可指定 `--stage dependencies`、`models`、`resources`、`configure` 或 `check`。使用 `--directory` 可选择安装位置。重复配置会保留已编辑的具名音色。语音插件与聊天授权仍由控制台管理。

## 配置方案

本地合成接收最多 4000 字，按句优先拆成约 90 字的推理批次，在同一次模型锁内完成。服务使用 GPT-SoVITS 环境已有的 NumPy/SciPy，将各批次经过抗混叠重采样拼接为 16 kHz 单声道 WAV，逻辑音频最多 1024 秒；微信语音气泡的分段由发送器处理。合成过程中切换方案会等待整条请求完成，不会让同一条回复混用权重。

准备好能运行 GPT-SoVITS API v2 的本地 Python 环境和模型目录，包括 `GPT_SoVITS/configs/tts_infer.yaml`、BERT、HuBERT、所需底模和语言资源。服务使用安装目录中已有的依赖和权重，配置文件的临时副本用于保存运行时状态。

推荐在界面里保存方案，默认文件为 `state/local-speech/tts.profiles.json`；无需手工编辑 JSON。也可指定已有的方案文件，例如 `state/local-gpt-sovits/profiles.json`。每个条目是一套具名音色方案。权重和参考音频路径相对于 GPT-SoVITS 安装目录，也可以填写该目录内文件的绝对路径。参考文本应与录音一致。

```json
{
  "studio": {
    "gptWeights": "voices/studio.ckpt",
    "sovitsWeights": "voices/studio.pth",
    "refAudio": "voices/reference.wav",
    "promptText": "这里填写参考录音中的文字。",
    "promptLang": "zh",
    "textLang": "zh"
  }
}
```

界面支持新增、编辑、扫描、删除方案，并保留方案级语速、采样温度、Top K/Top P、重复惩罚、段落间隔和 cut0～cut5 分句方式。请求不指定 speed 时使用方案默认语速，显式 speed 优先。语音对话插件在默认速度 1 时省略此字段，此时使用方案默认语速。“保存方案”只保存设置。使用本机合成时，“保存并使用”会加载对应权重与参考音频，完成后显示就绪。云端合成期间，这个按钮保存下次切回本机时使用的方案。

## 插件连接与可选的手动启动

托管模式无需以下手动命令。需要独立运行时，在项目目录下运行并替换两处安装路径。`--preload` 选定启动时加载的方案，省略时加载配置的第一项。

```powershell
$ttsPython = 'D:\VoiceEnv\Scripts\python.exe'
& $ttsPython -I -B scripts\local-gpt-sovits.py --model-root 'D:\GPT-SoVITS' --profiles state\local-gpt-sovits\profiles.json --preload studio
```

1. 在“语音对话 API → 语音合成”选择“自定义 API → 语音合成（OpenAI 兼容）”。服务地址填写 `http://127.0.0.1:9881/v1`，鉴权选择 Bearer。密钥保存在本机 `state/local-gpt-sovits/api.key`，只填入此本机服务的密钥栏。
2. 点击“读取模型和音色列表”，选择 `default` 作为模型可跟随界面已加载的音色；选择具体方案名会固定使用该音色。音色 ID 填 `default`。参考音频取自所选方案，语速可以在插件设置中调整。
3. 点击“试听”，确认音色后保存并选择授权聊天。在本地方案界面切换会立即加载，不等待下一次合成。同一进程一次处理一条请求；切换会等待正在进行的请求结束。插件直接指定其他方案名时仍可按请求切换。

运行服务的终端拥有该模型进程。按 Ctrl+C 结束本次服务并释放模型，其他正在运行的 GPT-SoVITS 实例继续使用各自的端口和配置。

托管服务由本项目独立的后台进程持有。当前账号的已授权合成路线全部切到云端时，后台释放 GPT-SoVITS。仍有本机路线时，服务继续运行。切回本机路线后，后台自动加载选定的音色。桌面和机器人各持有一个租约，最后一个使用者退出、断连或失去心跳后，后台关闭本项目启动的模型进程。

在连接设置启用本地合成并保存 Python 与安装目录，然后编辑方案。默认方案文件可留空，已有 JSON 路径也可继续使用。托管端口默认为 9881，也可在本地语音设置中指定独立端口。插件地址应使用界面显示的实际端口。模型预热不会修改插件或聊天授权；插件密钥与本地管理控制密钥分开保存。同一工作区的桌面控制台和机器人分别持有服务租约。后台管理进程从工作区读取已保存的启动设置，端口或模型根目录变更后重新启动对应服务。
