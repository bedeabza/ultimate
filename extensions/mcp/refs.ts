/**
 * MCP in the browser: each configured server's state and cached tools, and the actions that connect (signing in
 * through OAuth when the server asks) and refresh them. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** One configured MCP server as the panel shows it. */
export type ServerStatus = {
  name: string
  transport: 'http' | 'stdio'
  /** The URL, or the command line of a stdio server. */
  target: string
  /**
   * `idle` until first used, `authorizing` while a browser sign-in is pending, `needs-auth` when the server wants a
   * sign-in, `error` with `error` set.
   */
  state: 'idle' | 'connecting' | 'connected' | 'authorizing' | 'needs-auth' | 'error'
  error?: string
  /** While `authorizing`: the sign-in page to open in the browser. */
  authorizationUrl?: string
  /** Whether OAuth tokens are stored for it. */
  signedIn: boolean
  /** The cached tools, each callable from codemode as `tools.<call>`. */
  tools: { name: string; call: string; description: string }[]
  /** ISO time the tool list was last fetched. */
  refreshedAt?: string
}

/** No arguments → every server configured under `mcp.servers` in `~/.ultimate/settings.json`. */
export const StatusAction = actionRef<null, ServerStatus[]>('mcp', 'status')
/**
 * `{ server }` → its status after connecting and fetching its tools. A server that needs a sign-in comes back
 * `authorizing` with `authorizationUrl`; the flow finishes in the background once the browser returns to the
 * loopback redirect.
 */
export const ConnectAction = actionRef<{ server: string }, ServerStatus>('mcp', 'connect')
/** `{ server }` → its status after reconnecting and fetching its tool list again. */
export const RefreshAction = actionRef<{ server: string }, ServerStatus>('mcp', 'refresh')
