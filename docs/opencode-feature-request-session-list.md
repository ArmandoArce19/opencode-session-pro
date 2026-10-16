<!--
Borrador de issue para el repo OpenCode: https://github.com/anomalyco/opencode/issues/new
(antes sst/opencode, ahora redirige a anomalyco/opencode)

TÍTULO SUGERIDO (cópialo tal cual en el campo "Title"):

plugin: expose session listing and search in the plugin context

El cuerpo del issue empieza después de esta línea.
-->

## Summary

The V2 plugin context is documented as being "essentially an OpenCode server
client", but `ctx.session` exposes only `get`, `context`, `create`, `update`,
`move`, `prompt`, … — there is no way to **list** or **search** sessions. Any
plugin that wants to give the agent memory of previous sessions is forced to
reach into undocumented internals (the service registration file plus the local
HTTP API), which is fragile across releases.

Please expose session listing (and ideally server-side full-text search) in the
plugin context, matching what the HTTP API already provides.

## Environment

- opencode version: 2.0.30
- OS: Windows 10 (10.0.19045), win32 x64
- Terminal: xterm-256color
- Shell: cmd.exe
- Install/channel: latest
- Active plugins: one local V2 plugin at `~/.config/opencode/plugins/session-manager.js`

## Use case

An agent that can recall past work ("what did we do yesterday in this project?")
needs to:

1. List recent sessions, optionally scoped to a directory.
2. Read and search message content across sessions.

Today neither is reachable from a V2 plugin through the plugin API.

## Current behavior

`ctx.session` has no `list` and no search method. Over HTTP, `GET /api/session`
exists, but its `?search=` parameter only matches session **titles**, not message
content.

Plugins end up doing something like this, reading a file that is described as
internal state:

```ts
// ~/.local/state/opencode/service.json  (or $XDG_STATE_HOME/opencode/service.json)
const info = JSON.parse(readFileSync(registrationFile(), "utf8"));
const res = await fetch(new URL("/api/session", info.url), {
  headers: { Authorization: "Basic " + btoa("opencode:" + info.password) },
});
```

This works, but it depends on the registration file shape and the HTTP auth
scheme, neither of which is part of the plugin contract.

## Proposed API (sketch)

```ts
// ctx.session
list(input?: SessionListInput): Promise<SessionListOutput>   // e.g. GET /api/session
// optional but very useful:
search(input: { query: string /* ... */ }): Promise<SessionSearchOutput>
```

Even just `list` would remove the need for the workaround above.

## Additional context

- Several community "agent memory / session" plugins currently fail to load on
  V2 because they were written against the V1 plugin API (for example
  `opencode-session-manager`, `opencode-session-recall`, `opencode-session-tools`).
  The V2 loader rejects them with:
  `Plugin must export a default definition with an id and an effect or setup function`.
- Exposing session listing/search would let a whole class of such plugins be
  written against the public plugin API instead of private internals.
