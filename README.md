# opencode-session-pro

Give your [OpenCode](https://opencode.ai) agent **memory of past sessions**: list
them, read them, full-text search across them, and inspect their metadata.

> **Not affiliated with the OpenCode team.** This is an independent community
> plugin; `opencode-session-pro` is not built by, endorsed by, or affiliated
> with the OpenCode team.

OpenCode V2's plugin context does not expose session listing
(`ctx.session` has `get`, `context`, `create`, … but no `list`), so an agent
cannot normally look back at previous conversations. This plugin fills that gap.

## Tools

| Tool | What it does |
| --- | --- |
| `session_list` | List recent sessions (ID, title, agent, timestamps, outcome). Filter by title substring and date range. |
| `session_read` | Read the messages of one session in chronological order (user prompts, assistant replies, tool calls). |
| `session_search` | Full-text search across session **messages** (not just titles). Returns matched snippets with session ID, message index and timestamp. |
| `session_info` | Metadata and statistics: title, directory, agent, model, message counts, date range, duration, agents/models used, cost. |

Typical flow: `session_list` to discover an ID → `session_read` or
`session_search` for the content.

## Requirements

- OpenCode **V2** (2.0.x or newer)
- Node.js 20+
- No runtime dependencies, no build step

## Install

Add the package to the `plugins` array in your global OpenCode config
(`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-session-pro"]
}
```

Pin a version with `"opencode-session-pro@0.1.0"` if you prefer.

Restart the background service afterwards:

```sh
opencode service restart
```

### Local development

Point `plugins` at the directory instead of the package name:

```jsonc
{
  "plugins": ["./path/to/opencode-session-pro"]
}
```

## How it works

Because the plugin API cannot enumerate sessions, the plugin reads the local
service registration file the background service writes on startup:

- `$XDG_STATE_HOME/opencode/service.json`
- falling back to `~/.local/state/opencode/service.json`

From it the plugin takes the server `url` and `password` and calls the local
HTTP API with HTTP Basic auth (`opencode:<password>`). All four tools are
read-only.

## Limitations

- **Internal dependency.** The plugin relies on the service registration file and
  the local HTTP API. Those are not part of the stable plugin contract and may
  change between OpenCode versions. If OpenCode later exposes session listing in
  the plugin context, this plugin can be rewritten to use it.
- **Title vs. content search.** The API's `?search=` matches session *titles*
  only, so `session_search` scans messages on the client side (one request per
  session, capped at 25 sessions per call by `max_sessions`).
- **Message cap.** The API rejects `limit` greater than 200 per request, so at
  most 200 messages are read per session by `session_read` / `session_search` /
  `session_info`.
- **Read-only.** No session is created, modified or deleted.

## Development

```sh
npm test        # smoke test: loads the plugin and checks tool registration
```

## Publishing

1. Replace the `YOUR_NAME` / `YOUR_GITHUB_USER` placeholders in `package.json`
   and `LICENSE`.
2. `npm login`
3. `npm publish`

## License

MIT
