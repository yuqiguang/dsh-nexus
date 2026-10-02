# 从 nexus-next 迁移到 dsh-nexus

从 **0.2.32** 起，安装包名统一为 `dsh-nexus`，显示名称仍为 **Nexus 个人编码助理 / Nexus for DSH**。

| 用途 | 旧名称 | 新名称 |
| --- | --- | --- |
| 安装包与核心入口 | `nexus-next` | `dsh-nexus` |
| 长期记忆入口 | `nexus-next/memory` | `dsh-nexus/memory` |
| 邮箱入口 | `nexus-next/mail` | `dsh-nexus/mail` |
| 日历与待办入口 | `nexus-next/agenda` | `dsh-nexus/agenda` |

`nexus-channels`、`nexus-memory`、`nexus-mail`、`nexus-agenda` 是稳定的组件 ID，保持不变。原生会话、任务存储、凭据命名空间、托管编码工具目录和已保存的任务侧栏标识也不更名。

## 已安装旧包的用户

DSH 按包名识别安装项，不能把新包当作旧包的普通版本更新。请在原来的 DSH profile 中操作：

1. 等当前任务结束，并保留原安装包以便回退。
2. 在“插件”中卸载旧的 `nexus-next`，不要删除 DSH 数据目录或执行数据清理。
3. 添加 `dsh-nexus-0.2.32.tgz`，按提示启用并重启。
4. 确认只剩一个 Nexus 插件、四个组件入口均为 `dsh-nexus` 开头，并检查原有组件启用状态、设置、任务和记忆。

先移除旧包再添加新包，避免两个包同时声明同一组组件 ID。DSH 原生插件管理器写入的按 ID 启停设置可继续匹配；已卸载插件的业务数据不会因这次包名变化另建命名空间。新安装仍默认关闭三个可选组件，迁移则保留已有的启停设置。

## 手工配置过模块名称的用户

如果 profile 的 `cordis.patch.yml` 中有 `name: nexus-next` 或 `name: nexus-next/memory` 等配置限定，旧名称无法匹配新入口。关闭 DSH 后，在完成 `npm ci` 的本仓库中运行：

```bash
node scripts/rename-profile.mjs --check /absolute/path/to/profile
node scripts/rename-profile.mjs --apply /absolute/path/to/profile
```

Windows 的 profile 通常在 `%USERPROFILE%\.dsh\profiles\desktop`；请传入实际目录并给带空格的路径加引号。使用命令行管理包时，仍通过官方 `dsh plugin --profile <name> remove nexus-next` 和 `dsh plugin --profile <name> add /absolute/path/to/dsh-nexus-0.2.32.tgz` 完成包替换，再启动宿主。

脚本只转换上表四个入口与对应组件 ID 的匹配项，保留配置值、目录权限约束、启用状态和注释。按 ID 的配置、文件路径入口、其他插件和已退休的文档组件不改动。`--check` 不写文件；`--apply` 在原 profile 旁保留权限受限的旧补丁备份，不复制账号或会话数据。再次运行没有变化。备份可能包含私人配置，请仅保留在本机。

源码启动时，初始化逻辑也会转换这四个已知的旧模块引用。源码目录本身无需重命名。

## 回退

关闭 DSH，通过官方插件管理移除 `dsh-nexus` 并重新安装原版 `nexus-next`。如果转换过带模块名的配置，恢复迁移脚本保存的原补丁后再启动。不要在迁移后已有新配置修改的情况下直接覆盖补丁；先核对这些改动。包回退不恢复或重放任务，也不清空现有数据。
