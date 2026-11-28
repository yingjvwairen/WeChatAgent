# 副机运行

在开发机运行 `npm run secondary:export`，从当前提交生成源码 ZIP。命令会检查归档中的源码和插件、输出提交号与 SHA-256。也可以指定输出文件。

```powershell
node scripts/export-secondary.mjs --output D:\Transfer\WeChatAgent-source.zip
Get-FileHash D:\Transfer\WeChatAgent-source.zip -Algorithm SHA256
```

在目标 Windows 电脑上核对哈希、解压，在解压目录运行 `npm ci`、`npm run setup`、`npm run console`，然后连接该机的 DSH。在连接设置中选择该机的腾讯签名微信程序，登录自己的账号，再配置 Reader 和允许的聊天。运行配置、账号授权和聊天记录保存在各台机器自己的数据目录。

如果要在副机测试尚未提交的修改，运行 `npm run secondary:export -- --working-tree`。此模式读取工作区中的文件内容，包含未被 Git 忽略的新文件以及删除操作。源码检查仍会拒绝私有配置、运行数据及不一致的插件包。输出记录基线提交和 ZIP 摘要。正式源码与安装器从已提交的源码构建。

使用本地语音时，在目标电脑配置 VB-CABLE，并准备所需的识别模型或合成模型与参考音频。使用 OBS 推流时，为麦克风和桌面声音明确选择采集设备，再通过本机录制回放核对音轨。[本地识别](LOCAL_WHISPER.md) · [本地合成](LOCAL_GPT_SOVITS.md)

## 一次导入本机设置

在全新的副机源码目录运行 `npm ci` 后，将本机安装路径写入一份 JSON 文件。运行以下命令生成应用配置，再执行 `npm run setup` 和 `npm run console`。

```powershell
npm run secondary:configure -- --settings C:\\Deployment\\secondary.json
```

```json
{
  "runtime": {
    "python": "C:/Tools/Python/python.exe",
    "dshDesktop": "C:/Tools/DSH/DeepSeek Harness.exe",
    "localSpeech": {
      "asr": {
        "python": "C:/Tools/Whisper/python.exe",
        "modelDirectory": "C:/Models/whisper-small",
        "profiles": {
          "chinese": {"modelDirectory": "C:/Models/whisper-small", "language": "zh"}
        }
      }
    }
  },
  "input": {"wechatExecutable": "C:/Tools/Weixin/Weixin.exe", "controlMode": "ocr"}
}
```

按需添加 `localSpeech.tts`，填写 Python、模型根目录和 [GPT-SoVITS 方案字段](LOCAL_GPT_SOVITS.md)。也可省略 `localSpeech`。导入会校验应用路径、微信版本与签名以及方案文件，再发布配置。相同输入可重复执行，已有不同设置时会提示改用控制台。微信账号验证、聊天授权和音频线路核对仍在副机上完成。

## 检查推流音频

完成安装或源码环境准备后，运行 `npm run secondary:audio` 查看 CABLE 输入输出设备数量和三个 Windows 默认录音角色。检查已保存的 OBS 场景时，可用 `--obs-scenes` 指定场景集合的 JSON 文件。结果列出跟随默认设备、采集 CABLE 或开启监听的配置项数量。推流是否混入机器人语音，需在目标电脑的录制回放中核对。
