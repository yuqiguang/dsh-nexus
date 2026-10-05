# 第三方组件与许可

Nexus 自有代码采用 [MIT License](LICENSE)。第三方代码、程序和服务仍适用各自的许可证与服务条款，不因本项目的许可证而被重新授权。

0.2.48 升级依赖以清掉已知漏洞：`@larksuiteoapi/node-sdk` 1.66.1 → 1.74.0（该版本要求 axios ^1.16.0，axios 随之 1.13.6 → 1.20.0），并按上游声明范围更新传递依赖 `http-cache-semantics` 4.2.0 → 4.3.0、`ip-address` 10.7.0 → 10.7.3、`fast-uri` 3.1.7 → 3.1.8。新增的传递依赖为 axios 自身的 `https-proxy-agent`、`agent-base`、`debug`、`ms`，以及升级后的 `proxy-from-env` 2.1.0；均为 MIT。以上版本依据 0.2.34 的 `package-lock.json` 及对应已安装包中的许可文件核对，0.2.48 变更项另按该版锁文件核对。完整依赖树由锁文件记录；升级依赖后应重新核对。

0.2.56 未新增或升级第三方依赖，继续使用锁文件中的版本与下列许可说明。

## 分发范围

Nexus 的 `.tgz` 安装包包含本项目编译后的插件、客户端界面、配置、语言文件和项目说明，不打包 `node_modules`、DSH、React、Codex 或 Claude Agent SDK 的实现。服务端依赖在安装时由包管理器取得；客户端使用宿主提供的 React。源码开发依赖也由 `npm ci` 单独安装。

安装编码工具时取得的程序及其许可文件由各自的发布包提供。若另行制作包含依赖的离线安装器或整合发行版，须对实际包含的代码保留其版权与许可声明；本文不能代替这些声明。

## 直接运行依赖

| npm 包 | 锁定版本 | 包声明的许可证 |
| --- | --- | --- |
| `@larksuiteoapi/node-sdk` | 1.74.0 | MIT |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `@npmcli/config` | 10.4.2 | ISC |
| `@wecom/aibot-node-sdk` | 1.0.7 | MIT |
| `acorn` | 8.15.0 | MIT |
| `cacache` | 20.0.0 | ISC |
| `imapflow` | 1.7.8 | MIT |
| `jszip` | 3.10.1 | MIT OR GPL-3.0-or-later；本项目选择 MIT 选项 |
| `mailparser` | 3.9.28 | MIT |
| `nodemailer` | 10.0.10 | MIT-0 |
| `npm-registry-fetch` | 19.0.0 | ISC |
| `qrcode` | 1.5.4 | MIT |
| `silk-wasm` | 3.7.1 | MIT |

表中是直接依赖包的声明，不代表所有传递依赖或包内附带实现使用相同许可证。完整条款请查阅对应 npm 发布包内的 `LICENSE`、`NOTICE`、README 和其他许可文件。

## 宿主与编码工具

- **DeepSeek Harness（DSH）及其公开服务包**：本版精确匹配 `0.2.0-rc.2`，使用 MIT 许可的[官方项目](https://github.com/deepseek-ai/deepseek-harness)。`@deepseek-ai/cordis` 使用 `4.0.4`。Nexus 是独立第三方插件，不代表 DeepSeek 官方产品或背书。
- **React**：宿主提供 `18.3.1`，采用 MIT 许可。`zod` 也是 MIT 许可，其实际安装版本以锁文件为准。
- **Codex**：本版推荐 `0.155.1`，程序单独安装；其代码许可和模型服务条款分别适用，参见[上游项目](https://github.com/openai/codex)。本项目不附带其程序、账号或服务额度。
- **Claude Agent SDK**：本版推荐 `0.3.273`，为可选 peer 依赖和源码开发依赖。该发布包的 `LICENSE.md` 声明：

  > © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

  该 SDK 及其配套程序不属于 Nexus 的 MIT 授权范围。使用时适用 [Anthropic 的相关条款](https://code.claude.com/docs/en/legal-and-compliance)；本项目未授予额外的复制、分发或服务使用权。

微信、飞书、企业微信、邮件提供商及模型服务的账号权限、使用限制和数据处理条款各自适用。SDK 的开源许可证不代替平台服务授权。
