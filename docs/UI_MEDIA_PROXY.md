# 界面模式的私有媒体读取

界面模式的 Reader 地址和令牌由 `startTargetReader` 生成，只保留在运行进程里。DSH 插件通过项目现有的本机 adapter 获取图片、语音和视频；不再从旧 `wechat-io-config.json` 寻找界面模式的临时 Reader 凭据。

`runUiService` 的 `onReader` 回调发布当前内存能力，代次结束时撤销。`ui-reader-media-proxy.mjs` 提供以下 GET 路由：

- `/images/<64位十六进制ID>?conversationKey=wechat:private:<联系人ID>`
- `/media/<64位十六进制ID>?conversationKey=wechat:private:<联系人ID>`

这些路由只监听 `127.0.0.1`，校验精确 Host，拒绝任何 Origin，要求项目私有 `social-dsh-token`。同时要求当前账号、名单版本和联系人授权标识三个请求头。每次访问在转发前和返回后检查账号与名单；名单变更、Reader 退出、关闭服务会中止未完成的读取。旧 Reader 的迟到回调不能撤销新代次。服务状态接口不返回 Reader 能力或令牌。

插件公共内部函数为：

```js
fetchBoundReaderMedia(root, 'images' /* 或 'media' */, id, conversationKey, { signal })
```

实现位于 `packages/dsh-social-bridge-plugin/reader-media-access.mjs`，图片和音视频共用。它只读取项目自己的配置、活动账号、名单和本机桥接令牌，不读取 DSH 模型凭据。界面模式失败时不会退回旧 Reader 地址。旧后端的现有本机 Reader 图片路径保留兼容，依然要求 HTTP `127.0.0.1` 和响应会话一致。

成功响应只保留图片/音视频的已知字段；Reader 内部来源和凭据不进入模型上下文。客户端继续逐项校验图像或视频帧的 ID、会话、格式、大小与内容哈希。单个响应最多 6 MiB；图片请求最多 12 秒，音视频最多 120 秒，并受调用方更短的取消信号限制。转写和画面内容是未经信任的消息输入，媒体读取本身不表示模型已经理解了内容。

验证入口：

```text
node --test scripts/test-ui-reader-media-proxy.mjs scripts/test-image-input.mjs scripts/test-ui-service.mjs
```

测试使用临时目录和真实本机 HTTP 服务，覆盖旧配置不回退、身份与授权拒绝、在途改选、关闭取消、账号/令牌变化、响应大小以及新旧代次竞态，不启动微信或执行聊天发送。
