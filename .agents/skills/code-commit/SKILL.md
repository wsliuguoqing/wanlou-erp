---
name: code-commit
description: Commit requested code changes on the current project branch after reviewing the staged diff and required checks. Use when the user asks to commit changes; do not push unless asked.
---

# Code Commit

为本项目提交代码时遵循以下约定：

- 先读 `CLAUDE.md` 的开发约定，检查当前分支、`git status` 和完整差异。只提交用户本次要求的变更，并保留已有的用户修改。
- 分别检查已跟踪文件差异和未跟踪文件。不要使用 `git add .` 或 `git add -A`；按路径暂存目标文件，再检查 `git diff --cached` 和 `git diff --cached --check`。
- 不要提交真实数据库、数据库备份、日志、临时测试目录、密钥或无关生成文件。真实业务库位于 `data/`，不得加入版本控制。
- 按仓库约定运行必要验证。此项目的 `CLAUDE.md` 要求提交前运行 `node test/flow-test.js`；相关专项回归也应一并运行。测试失败时不提交，先说明失败原因。
- 使用中文、一句话描述修复的业务问题作为提交说明。提交前确认暂存区只包含目标改动；不要 amend 既有提交、改写历史或推送远端，除非用户明确要求。
- 提交成功后报告提交哈希、说明和验证结果。如果没有可提交的改动，直接说明，不创建空提交。
