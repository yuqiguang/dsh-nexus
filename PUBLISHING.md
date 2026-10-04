# 发布实验版

本仓库是公开源码目录。产品名为 **Nexus 个人编码助理 / Nexus for DSH**，GitHub 仓库为 `yuqiguang/dsh-nexus`，npm 包标识为 `dsh-nexus`。旧包 `nexus-next` 的迁移方式见 [RENAME.md](RENAME.md)。组件 ID 和数据存储标识保持不变。

公开发行包从 0.2.41 起同时通过 npm 和 GitHub Release 分发。`publishConfig` 固定 npm 官方源、公开访问和实验版 `next` 标签；只从经过检查的公开源码目录发布。私有开发目录继续保留 `private: true`，不从那里发布 npm 包。

## 验证和打包

更新版本时同步 `package.json`、`package-lock.json`、README、CHANGELOG 和第三方依赖说明。以下以 0.2.45 为例；仅文档和包元信息变化时，可沿用编译产物，但必须核对运行源码与产物均未变化，并重新计算安装包摘要。

源码发生变化时，在干净工作树中串行执行：

```bash
npm ci
npm run check
npm run build
node --max-old-space-size=384 --test --test-reporter=spec --test-concurrency=1 dist/test/*.test.js
npm run smoke
```

单元测试直接调用 Node，避免 `npm run` 注入本机 registry/cache 配置、覆盖本地测试夹具。依赖未变且 pnpm 缓存齐全时，可用 `NEXUS_SMOKE_OFFLINE=1 npm run smoke` 运行原生检查。

停止其他 DSH 实例后运行资源密集的构建与集成检查。记录实际通过的检查；没有执行的真实账号或 Windows 流程不得写成已通过。

使用已验证的 `dist` 打包；下面的目录和摘要命令适用于 Linux / WSL：

```bash
mkdir -p release/0.2.45
npm pack --ignore-scripts --pack-destination release/0.2.45
tar -tzf release/0.2.45/dsh-nexus-0.2.45.tgz
cd release/0.2.45
sha256sum dsh-nexus-0.2.45.tgz > SHA256SUMS
sha256sum -c SHA256SUMS
```

包内应包含 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`CHANGELOG.md`、README、包元信息、编译后的插件与客户端、语言文件和配置层。`dist/build-info.json` 随包记录实际构建身份；源码服务另使用构建生成的 `dist/plugin.tgz`，它不会被嵌套打进安装包。

不应包含 `.git`、`.nexus`、`.dsh`、真实环境变量文件、工作区、私有文档、测试数据或 `node_modules`。检查跟踪文件及 Git 历史中的敏感信息，不能只检查当前安装包。

## npm 发布

先完成源码提交和安装包校验，再将同一个 `.tgz` 发布到 npm 和 GitHub，避免重复打包产生不同字节。仅文档和发行元信息变化时，允许复用上版编译文件：逐文件核对运行源码及编译内容，更新发行构建身份，并在说明中记录复用来源。

首次发布前登录 npm CLI（仅在网站登录不够）；WSL 可禁用自动打开浏览器并手动完成授权：

```bash
npm login --registry=https://registry.npmjs.org/ --browser=false
npm whoami --registry=https://registry.npmjs.org/
npm publish ./release/0.2.45/dsh-nexus-0.2.45.tgz --access public --tag next --registry=https://registry.npmjs.org/ --ignore-scripts
npm dist-tag add dsh-nexus@0.2.45 latest --registry=https://registry.npmjs.org/
npm dist-tag ls dsh-nexus --registry=https://registry.npmjs.org/
```

若 npm 要求二次验证，在本机终端按提示完成；本账号的写操作（含 `npm dist-tag`）需要一次性密码，命令行补 `--otp=<六位验证码>`。不要提交凭据或授权链接。

不要把占位数字当作 `--otp` 传进去：错误密码返回 401，npm 随即自动重试，而这时账号已因多次错误 OTP 被限流，三次重试全部返回 429——一次错误的 OTP 会放大成账号级限流。改成不带 `--otp`、让 npm 交互式提示，或确认已从验证器取到当前六位码后再执行。TOTP 只有 30 秒有效期，先取码再敲命令会过期。遇到 429 时停止重试、等待冷却，重试只会延长限流窗口。

发行标签：`next` 与 `latest` 都指向最新实验版，这样在 DSH“添加插件”里直接填写 `dsh-nexus` 就能装到当前版本，而不是落到 0.0.0-stage 那个占位空包；也可以填写 `dsh-nexus@next` 或指定版本。`npm publish --tag next` **不会**移动 `latest`，所以发布后必须单独执行 `npm dist-tag add`，否则 `latest` 会一直停在旧版本。

需要留意的后果：`latest` 跟随实验版，意味着只写包名的用户会直接拿到实验版，而不再有“裸包名落到稳定版”的保护；当前没有稳定的非实验版可指，如将来需要，再单独为 `latest` 指定该版本。

npm 发布成功后核对版本、`next` 与 `latest` 标签、registry 的 integrity，并下载 npm tarball 比对本地 SHA256。再发布包含同一安装包的 GitHub Release，等待固定入口工作流完成并验证下载。npm 已发布版本不可覆盖；若 GitHub 后续步骤失败，保留 npm 版本并补完 GitHub 发布，不重复改包。插件内更新仍依赖 GitHub 版本附件与固定入口，发布 npm 本身不会更新插件的更新源。

## GitHub Release

1. 审阅并推送公开源码提交；从实际用于打包的源码提交创建 `v0.2.45` 标签。
2. 创建 Release，标题使用 `Nexus 0.2.45（实验版）`，勾选预发布选项。说明使用 CHANGELOG 中对应版本的内容。
3. **先上传** `dsh-nexus-0.2.45.tgz` 和 `SHA256SUMS`，再发布 Release。校验文件必须包含该安装包的 SHA256。
4. 发布后，GitHub Actions 的 **Update fixed installation link** 工作流自动校验这份已发布安装包，将相同字节同步到固定入口。它不重新构建安装包；运行失败时先查看日志，修正后通过 **Run workflow** 输入对应版本标签重试。
5. 下载已发布版本附件及固定入口附件，检查 SHA256 与已验证安装包一致。源码公开和创建标签不会自动生成版本安装包。

固定安装地址：

```text
https://github.com/yuqiguang/dsh-nexus/releases/download/install/dsh-nexus.tgz
```

对应校验文件为同一路径下的 `SHA256SUMS`。GitHub 的 `/releases/latest/` 不包含预发布版本，因此这里使用专门的 `install` 入口。所有版本都勾选预发布后，`/releases/latest/` 会返回 404，这是预期结果而非故障；插件更新只读 `install` 入口，不读这个地址。

`install` 是明确可变的分发标签：工作流只更新它及其两个固定附件，页面标明实际来源版本，并指向原版本的源码和说明。更新前验证源包 SHA256，先上传候选文件再切换名称；名称切换失败时恢复旧文件。较旧版本晚发布时不会覆盖较新入口。操作由工作流串行执行；不要同时手动运行同步脚本。

工作流只需要仓库的 `contents: write` 权限，不需要额外密钥。若用另一个工作流的 `GITHUB_TOKEN` 发布版本，GitHub 不会为它自动触发 `release` 工作流；发布方还需显式调用本工作流的 `workflow_dispatch`，或手动运行。源码版本标签及对应附件保持不变；不要将 GitHub 自动提供的 Source code 压缩包作为插件安装包。

本地检查发布逻辑：

```bash
node --test --test-concurrency=1 test/install-link.test.mjs
```

若只调整发行资料而沿用版本号，保留旧包及其验证记录，明确新包的摘要；一旦版本标签或 Release 已公开，不应悄悄替换其源码或附件。固定入口是上述明确约定的例外，更新时始终保留原版本发布。运行代码再次修改时使用新的版本号。

## 插件内更新检查

0.2.39 起，Windows 桌面插件读取固定入口的 `nexus-install-source` 标记，然后下载对应版本 Release 的 `SHA256SUMS` 和 `dsh-nexus-版本.tgz`。必须先完整发布不可变的版本附件，再更新固定入口；保留历史附件供安装前准备回退包。安装包必须由干净的已提交源码构建，包含正确的 `dist/build-info.json` 与精确 DSH peer 依赖。开发构建和找不到对应发布回退包的构建不会自动安装。

自动检查默认开启，空闲安装需用户选择；更新后需正常重启 DSH 激活，不强制重启。安装阶段失败会尝试恢复旧版，不能保证修复重启后完全无法加载的新版。第一批 0.2.38 用户仍需手动安装 0.2.39。

停止其他 DSH 实例后串行验证：

```bash
node --max-old-space-size=384 --test --test-concurrency=1 dist/test/updates.test.js dist/test/update-ui.test.js
node --max-old-space-size=384 scripts/check-plugin-updates.mjs
```

原生安装夹具只使用合成组件与凭据，不代替 Windows 真实任务验收。
