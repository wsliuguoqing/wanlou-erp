---
name: restart-service
description: Safely restart this repository's local inventory system after the user requests a restart or code changes need loading. Use for the Windows Node.js service on port 3000; do not restart unrelated processes.
---

# Restart Service

重启本项目本机服务时：

- 先确认仓库根目录、`CLAUDE.md` 中的启动方式和服务端口。默认命令为 `node src/server/server.js`，默认端口是 3000，数据库默认位于 `data/wanlou.db`。
- 仅在用户要求重启，或当前任务明确要求应用新代码时执行重启。创建或编辑此技能本身不构成重启授权。
- 重启前检查 3000 端口监听进程，并读取 PID、命令行和工作目录。只有确认进程运行的是本仓库的 `src/server/server.js` 后才停止它；优先使用正常退出。若端口被其他或无法识别的进程占用，不要强杀，报告占用情况并停止重启。
- 启动服务时使用本仓库为工作目录，保持默认端口和数据库路径；后台启动应使用隐藏窗口。不要删除、重建、替换或清理 `data/wanlou.db`，也不要因数据库锁而移除 SQLite 的 WAL 文件。
- 启动后检查进程仍在运行，并请求 `http://localhost:3000/` 确认服务响应。若本机网络或权限隔离导致无法访问，说明实际验证边界，不要把端口占用误报为启动成功。
- 如果新进程启动失败，只停止本次启动且已确认属于本仓库的进程；保留原数据库和日志，报告错误与下一步。
