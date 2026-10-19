# Notes for agents

- Codex accounts (src/codex.js): `reconcile()` must only adopt CC Switch tokens issued after ours (later access-token `exp`), because OpenAI refresh tokens are single-use; adopting an older copy reinstates a spent refresh token and locks the account out.
- The ChatGPT backend may stream Responses without a `content-type`; keep treating `stream: true` responses as SSE so token usage is still recorded.
- CC Switch writes may update only the bound row's auth tokens and auth.last_refresh, only when ours are newer and sync is on; reads stay read-only. Re-check identity and token exp inside BEGIN IMMEDIATE and back up before the first write, because single-use refresh tokens must never be rolled back or unrelated CC Switch settings changed.
- The live router on port 18787 may be carrying the user's own Claude Code session. Don't stop or restart it without asking.
