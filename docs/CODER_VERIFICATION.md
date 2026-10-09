# 编码任务的检查与恢复

任务执行、独立检查与用户业务验收分别记录。编码工具返回成功、某个工具退出 0 或文件已经展示，都不会自动完成整份说明单。

## 登记逐项检查

`coder_task.verify_commands` 是完整检查列表，每条直接启动实际程序，按顺序执行；失败后保留该项失败，并把后续命令记为未执行。不要用 `pwsh -Command`、`bash -c` 或 `cmd /c` 拼接检查并打印子进程退出码。需要包装脚本时，脚本本身必须检查失败并返回非零退出码。

多项验收用 `acceptance_checks` 明确关联，命令必须同时列在 `verify_commands` 中。`files` 相对任务 `cwd`，与 `verify_cwd` 无关。例如：

```json
{
  "description": "按说明单完成项目并准备检查入口",
  "brief_id": "当前说明单 ID",
  "brief_revision": 1,
  "acceptance_ids": ["a1", "a2"],
  "verify_commands": [
    "python checks/check_output.py",
    "python checks/check_docs.py",
    "python checks/reproduce.py changed-input"
  ],
  "outputs": ["result.zip", "README.md", "status.json"],
  "acceptance_checks": [
    {"criterion": "a1", "commands": ["python checks/check_output.py"], "files": ["result.zip"]},
    {"criterion": "a2", "commands": ["python checks/check_docs.py", "python checks/reproduce.py changed-input"], "files": ["README.md", "status.json"]}
  ]
}
```

检查脚本应覆盖约定的实际行为：文档是否更新、报告引用的交付文件是否生成、修改输入后的分支是否真正运行等。Nexus 不从业务关键词生成断言；只做语法检查不能证明这些要求已满足。

`outputs` 和 `files` 会检查普通文件、真实路径与内容摘要。文件存在不证明内容正确；内容语义由对应命令检查。交付汇总及用户验收时重新核对这些文件的摘要，检测到验证后的变化会显示需复验，不改写原任务。未声明的文件仍可能出现在改动审计中，但不会据此自动算作交付物或发送到渠道。

单验收项任务可以沿用它已登记的完整检查列表。多验收项没有明确对应关系时，任务级检查结果仍保留，各项显示证据未齐；旧记录不会补造已执行检查。某项通过不会覆盖另一项的失败或未执行，整体交付还须满足任务验证及用户验收。

步骤计划也支持 `acceptance_checks`、`outputs`。计划的 `verify` 为第一条命令，`verify_commands` 为追加命令；任务工具的 `verify_commands` 则为完整列表。续接可以增加检查，但不能丢弃同版本已有命令、文件和验收项；修改要求应先变更说明单版本。

## 沿原任务恢复

先读取 `coder_brief` 的 `recover`。没有步骤计划时，恢复清单同样会提供最新任务的续接参数。已有后续执行的旧任务不能再次恢复。

- 编码中断：用户明确继续后，用最新任务的 `retry_task_id` 或 `resume_task_id` 核对已有文件并完成剩余工作。有原生编码会话时沿原会话续接。
- 编码已结束、验证失败或条件需修正：指定最新任务并设置 `verification_only: true`，只运行宿主检查。中断编码不符合这一条件。
- 交付：读取 `coder_brief delivery`，补齐各项检查与声明文件；需要用户确认实际业务效果时调用 `review`。主会话临时检查不会替代原恢复链中的独立验证。

原任务状态及审批历史保留。原生用户回答只授权当次请求，并关联任务、目录、会话和目标版本；曾批准探针不代表批准后续扩大范围的执行。

## 重试与显示

工具内部重试和 Nexus 自动续接分别计数。两者共享本次任务的无进展等待计时：自最后一次成功操作起，累计重试等待 5 分钟提醒、10 分钟暂停。审核或用户等待不占此计时；普通状态消息不会把计时清零，成功工具操作会重置它。原有总运行预算和最多两次自动续接限制继续生效，重启不重放任务或审批。

改动摘要优先展示明确声明的文件、代码和报告；`pydeps`、虚拟环境、包目录与已知缓存分组。编号图片仍保留在项目文件和完整审计中，目录外改动检查不因显示分组而省略。

上述机制使用本地模型与文件样例做回归；本地通过不代表真实外部服务或 Windows 桌面发布验收通过。
