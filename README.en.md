# RelayRouter (Smart Relay Router)

[简体中文](README.md) | English

RelayRouter is a local API router for Claude Code. It connects multiple Anthropic Messages API-compatible relay providers behind one local endpoint, routes requests by priority, and can retry, fail over, and recover when a provider is unhealthy.

## Features

- Automatic routing or a pinned-provider mode, with priority ordering, error classification, retries, cooldowns, and scheduled health probes.
- Streaming and non-streaming Messages requests, plus discovery of models supported by each provider.
- Optional model mapping, context-limit handling, conversation summarization, and cost-aware failover.
- A local dashboard for provider health, request history, usage statistics, and router settings.
- Import Claude providers from the local CC Switch database or configure them in the dashboard.

## Requirements

- Node.js **22.5 or later** (uses the built-in SQLite module).
- Install npm dependencies before the first run (sharp handles local image optimization).

## Quick start

From the project directory, run:

```powershell
npm install
npm start
```

Then open [http://127.0.0.1:18787](http://127.0.0.1:18787). On first launch, the router creates local configuration under `data/`. Add or import providers in the **“中转站” (Relays)** page and arrange their priority. The local endpoint and router key are shown on the **“接入指南” (Connection Guide)** page.

Set the Anthropic API base URL in Claude Code or CC Switch to `http://127.0.0.1:18787` and use the router key shown in the dashboard. You can leave the model field empty so the router can select an available provider.

By default, the server listens only on `127.0.0.1`; `/v1/*` routing endpoints require the router key. Keep the key private.

## API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/messages` | Forward a Claude Messages request |
| `POST` | `/v1/messages/count_tokens` | Estimate or forward token-count requests |
| `GET` | `/v1/models` | Return the discovered model catalog |
| `GET` | `/health` | Local health check |

## Local configuration and privacy

Provider URLs, API keys, router settings, and runtime data are stored locally under `data/`. The data directory, environment files, logs, and database files are ignored by `.gitignore` and should not be committed to a public repository. Set `SMART_ROUTER_DATA` to use a different local data directory, or `SMART_ROUTER_PORT` to override the default port.

By default, the CC Switch database is read from the current user's configuration directory. Set `CC_SWITCH_DB` to use another database. Imported credentials are only for local use; do not copy them into source code, README files, screenshots, or public issues.

## Development

Run the router's test suite with:

```powershell
npm test
```

For additional details on model discovery and routing, see [MODELS.md](MODELS.md).

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
