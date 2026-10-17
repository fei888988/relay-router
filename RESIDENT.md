# 智能路由后台常驻

已安装 Windows 计划任务 `ClaudeSmartRouter`：机器启动时运行，无需登录；后台无窗口；路由进程退出后 5 秒重启。监督进程异常退出由计划任务在 1 分钟后重试。电池供电仍运行，无运行时长限制。

控制面板：http://127.0.0.1:18787

常驻入口：`resident.ps1`。继续使用本目录 `data` 中的配置与数据。
日志：`data\resident.log`，超过 10 MB 后轮换，保留上一份 `.1`。日志可能包含路由密钥，请勿公开。

管理命令（管理员 PowerShell）：

- 查看：`Get-ScheduledTask -TaskName ClaudeSmartRouter`
- 停止并禁止自动启动：`Disable-ScheduledTask -TaskName ClaudeSmartRouter; Stop-ScheduledTask -TaskName ClaudeSmartRouter`
- 恢复：`Enable-ScheduledTask -TaskName ClaudeSmartRouter; Start-ScheduledTask -TaskName ClaudeSmartRouter`

原来的 stop.bat 只终止路由进程，常驻监督会重新启动它。停用常驻请使用上面的管理命令。

项目目录和 Node.js 安装路径变动后，需要相应更新常驻入口和计划任务。
