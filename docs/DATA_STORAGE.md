# 安装位置与数据目录

安装时只需选择一次根目录：程序自动放入 `app`，WeChatAgent 的数据自动放入同级 `data`，不再要求第二次选择数据文件夹。程序与数据目录保持分离；卸载只删除程序目录，默认保留数据。

从旧 fork 切换到微信 4.2.0.53 桌面发送版时，请选择独立的安装根目录，在首次启动时使用新的空数据目录。用该版本重新选择微信账号、连接 DSH 并添加自动回复对象。切换前，在原程序里核对待发消息、草稿和录音，然后停止旧服务并备份旧数据。

桌面发送版以「WeChatAgent Desktop」安装，可和旧版分别卸载。两者使用同一微信或 DSH 时，请在切换前停止正在运行的机器人。

如果新程序已指向旧数据目录，先退出应用，再把 `app/storage.ini` 中 `[Storage]` 的 `dataHome` 指向空目录，并将 `migrationSource=` 留空。

例如选择 `D:\WeChatAgent`：

```
D:\WeChatAgent\app\WeChatAgentDesktop.exe
D:\WeChatAgent\data\workspace\
D:\WeChatAgent\data\runtimes\
D:\WeChatAgent\data\desktop\
```

`workspace` 保存配置、人设、表情包、群友记忆、群聊关联、聊天缓冲、消息处理进度与发送回执。`runtimes` 保存内置运行环境。`desktop` 保存界面设置和缓存。DSH 需要单独安装，其数据由 DSH 管理。

## 移动本版本的数据

该版本的工作区使用配置版本 `2` 和完整微信 ID。移动这种工作区时，可在首次启动显示的来源和目标中核对路径后选择迁移。数据包括账号凭据、人设、聊天授权、消息处理进度和发送回执。移动前核对在途投递，并退出当前应用。跨电脑或跨 Windows 用户移动后，请在连接设置重新验证账号。

`app\storage.ini` 记录数据位置，`data\.wechatagent-data.json` 和 `data\backups\migration.json` 记录迁移结果。若原插件是从旧工作区的本机目录添加的，请在 DSH 插件页重新添加“连接设置”里显示的新目录，再从托盘完整退出并重新打开 DSH。确认模型连接与微信账号后再启动机器人。
