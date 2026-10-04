# 参与开发

请先阅读 [README](README.md) 的版本要求、权限说明和已知限制。Nexus 通过官方公开服务扩展 DSH；原生会话、执行、审批和恢复由 DSH 管理。

## 问题反馈

在 [Issues](https://github.com/yuqiguang/dsh-nexus/issues) 提供插件/DSH 版本、操作系统、复现步骤、预期与实际结果，以及脱敏后的错误信息。涉及编码工具时补充工具种类、版本和运行模式。

不要附带账号数据、凭据文件、带认证的地址、原始会话历史或含私人内容的工作区。优先提供独立的小型复现项目和本地夹具。

## 修改与验证

需要 Node.js 22.20.0 或更新版本。按顺序运行：

```bash
npm ci
npm run check
npm run build
npm test
```

涉及 DSH 生命周期、审批、渠道投递或恢复时，再运行 `npm run smoke`。构建、测试和集成检查应串行执行；资源有限时先停止其他 DSH 实例。集成检查使用临时目录和本地夹具，真实账号或渠道消息测试需另行明确安排。

受限本地检查需要 `bubblewrap`、`iproute2` 和允许非特权用户命名空间的内核。`npm test` 中相关用例缺少依赖时会**跳过并说明缺少哪一项**（例如 `# bubblewrap (bwrap) is not installed`），不会静默通过；`npm run smoke` 会真实走这条路径，缺少依赖时直接失败。CI 自动安装 `bubblewrap`，真实隔离覆盖不会因本机缺少依赖而丢失。

先说明可复现的问题及原因，再在失败边界做最小修改。不要修改 `node_modules`、复制 DSH 执行循环，或为修复界面/投递而重跑用户任务。远程消息必须绑定明确的所有者，审批和工作区边界不得扩大。

PR 请说明改动后的行为、验证结果及未覆盖的范围。新增依赖时更新锁文件和 [第三方说明](THIRD_PARTY_NOTICES.md)；发布步骤见 [PUBLISHING.md](PUBLISHING.md)。
