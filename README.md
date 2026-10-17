# RelayRouter（中转站智能路由）

[简体中文](README.md) | [English](README.en.md)

RelayRouter 是一个运行在本机的 Claude Code API 路由器。它把多个兼容 Anthropic Messages API 的中转线路接入一个本地地址，并按优先级转发请求；线路异常时可以自动重试、切换和恢复。

## 功能

- 自动路由与固定线路模式，支持优先级、错误分类、快速重试、冷却和定时探活。
- 转发流式与非流式 Messages 请求，并发现线路支持的模型。
- 可选模型映射、上下文超限处理、会话摘要压缩和成本感知故障切换。
- 本地控制面板展示线路状态、请求记录、用量统计和路由设置。
- 可从本机 CC Switch 导入 Claude 线路，也可以在控制面板手动配置。

## 运行要求

- Node.js **22.5 或更高版本**（使用 Node.js 内置 SQLite）。
- 无需额外安装 npm 依赖。

## 快速开始

在项目目录运行：

```powershell
npm start
```

启动后打开 [http://127.0.0.1:18787](http://127.0.0.1:18787)。首次启动会在 `data/` 中创建本地配置；可在「中转站」页面导入或添加线路，并调整优先级。路由接入地址和路由密钥可在「接入指南」页面查看。

将 Claude Code 或 CC Switch 的 Anthropic API 地址设为 `http://127.0.0.1:18787`，并使用控制面板提供的路由密钥。模型可留空，由路由器根据可用线路选择。

默认仅监听本机地址 `127.0.0.1`；`/v1/*` 路由接口默认需要路由密钥。请把本地路由密钥当作凭据保管。

## API 端点

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/v1/messages` | 转发 Claude Messages 请求 |
| `POST` | `/v1/messages/count_tokens` | 估算或转发 token 计数请求 |
| `GET` | `/v1/models` | 返回已发现的模型列表 |
| `GET` | `/health` | 本机健康检查 |

## 本地配置与隐私

线路地址、API 密钥、路由设置和运行数据保存在本地 `data/` 目录中。该目录、环境变量文件、日志和数据库文件已加入 `.gitignore`，不应提交到公开仓库。`SMART_ROUTER_DATA` 可指定其他本地数据目录，`SMART_ROUTER_PORT` 可覆盖默认端口。

CC Switch 数据库默认从当前用户配置目录读取；需要使用其他数据库时，可设置 `CC_SWITCH_DB`。导入的凭据只用于本机运行，不应复制到源码、README、截图或公开 issue 中。

## 开发

运行项目自带的路由器测试：

```powershell
npm test
```

模型发现与路由行为的补充说明见 [MODELS.md](MODELS.md)。

## 许可证

本项目采用 Zero-Clause BSD（0BSD）许可证，见 [LICENSE](LICENSE)。
