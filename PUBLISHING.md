# 发布实验版

本仓库是公开源码目录。产品名为 **Nexus 个人编码助理 / Nexus for DSH**，GitHub 仓库为 `yuqiguang/dsh-nexus`，npm 包标识为 `nexus-next`。这些名称用途不同；不要仅为外观更名而改变已有插件或组件身份。

`private: true` 用于阻止误发布到 npm，不影响 GitHub 源码或本地 `.tgz` 分发。当前使用 GitHub Release 分发安装包。

## 验证和打包

更新版本时同步 `package.json`、`package-lock.json`、README、CHANGELOG 和第三方依赖说明。以下以 0.2.31 为例；仅文档和包元信息变化时，可沿用编译产物，但必须核对运行源码与产物均未变化，并重新计算安装包摘要。

源码发生变化时，在干净工作树中串行执行：

```bash
npm ci
npm run check
npm run build
npm test
npm run smoke
```

停止其他 DSH 实例后运行资源密集的构建与集成检查。记录实际通过的检查；没有执行的真实账号或 Windows 流程不得写成已通过。

使用已验证的 `dist` 打包；下面的目录和摘要命令适用于 Linux / WSL：

```bash
mkdir -p release/0.2.31
npm pack --ignore-scripts --pack-destination release/0.2.31
tar -tzf release/0.2.31/nexus-next-0.2.31.tgz
cd release/0.2.31
sha256sum nexus-next-0.2.31.tgz > SHA256SUMS
sha256sum -c SHA256SUMS
```

包内应包含 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`CHANGELOG.md`、README、包元信息、编译后的插件与客户端、语言文件和配置层。不应包含 `.git`、`.nexus`、`.dsh`、真实环境变量文件、工作区、私有文档、测试数据或 `node_modules`。检查跟踪文件及 Git 历史中的敏感信息，不能只检查当前安装包。

## GitHub Release

1. 审阅并推送公开源码提交；从实际用于打包的源码提交创建 `v0.2.31` 标签。
2. 在 GitHub 创建 Release，标题使用 `Nexus 0.2.31（实验版）`，勾选预发布选项。
3. 说明使用 CHANGELOG 中的对应版本内容，附上 `nexus-next-0.2.31.tgz` 和 `SHA256SUMS`。
4. 下载已发布附件，检查 SHA256 与本地记录一致。源码公开和创建标签不会自动生成或上传安装包。

若只调整发行资料而沿用版本号，保留旧包及其验证记录，明确新包的摘要；一旦某个标签或 Release 已公开，不应悄悄替换它的源码或附件。运行代码再次修改时使用新的版本号。
