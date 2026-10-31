Connects Ultimate to your MCP servers (streamable HTTP or stdio), with OAuth sign-in, behind one `mcp` tool and codemode's `tools.<server>__<tool>`.

Off by default. Turn it on for this machine with `"extensions": { "enable": ["mcp"] }` in `~/.ultimate/settings.json`, and list servers in the same file:

```json
{
  "extensions": { "enable": ["mcp"] },
  "mcp": {
    "servers": {
      "superhuman": { "url": "https://mcp.mail.superhuman.com/mcp" },
      "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
    }
  }
}
```

A `url` speaks streamable HTTP; a `command` (with optional `args`, `env` and `cwd`) runs a stdio server as a child process. Names use letters, digits, `-` and `_`. Configuration is user-level only: a project's settings do not add servers. The legacy SSE transport is not supported.

## Tools

- `mcp` (offered to the model): `servers` lists each server with its state and tools, `tools {server}` gives one server's tool schemas (connecting first), `call {server, tool, arguments}` runs one.
- `mcp_search` (deferred, loaded through `tool_search`): searches the cached tools by name and description.
- Every cached MCP tool is registered as `<server>__<tool>` with `callers: ['tools']`: the model is never offered it, so the prompt stays one tool however many servers there are, and codemode scripts call it directly as `tools.<server>__<tool>(args)`.
- An agent whose definition lists its `tools` gets only what it names: @ultimate lists `mcp` and calls servers through it (also from codemode, as `tools.mcp({action: 'call', …})`).

Tool lists are cached in `~/.ultimate/mcp/tools/<server>.json` and registered from there at install. Connecting (the first `tools` or `call`, or Connect in the panel) fetches the list again; a changed list reinstalls the facet.

Every tool is enabled, write tools included, with no confirmation. Each result starts with a banner naming its server and saying its content is data, not instructions, and the `mcp` prompt section says the same: MCP output (an email, an issue, a web page) can carry prompt injection.

## Sign-in

A server that answers 401 gets OAuth 2.1 with PKCE and dynamic client registration, through the SDK. Connect in the panel opens the authorization page in a new tab; the browser comes back to a loopback redirect (`http://127.0.0.1:<port>/callback`, the port chosen once per server) and the server connects. A model call while a sign-in is needed returns an error naming the sign-in page. The sign-in works only with a browser on the machine running Ultimate.

Client registration, tokens and the PKCE verifier live in `~/.ultimate/mcp/tokens/<server>.json`, mode 0600, and are refreshed there. They never enter prompts, traces or the panel.

## Panel

The MCP tab of the right panel (⌘K → MCP servers…) lists each server with its state, Connect or Refresh, its last error, and its tools behind a disclosure.

Built on [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk).
