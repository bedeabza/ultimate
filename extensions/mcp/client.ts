/** MCP connections: configuration, OAuth credentials on disk, the loopback sign-in and the cached tool lists. */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import type {
  CallToolResult,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
  Tool,
} from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { readJson, writeJson } from '../../lib/json-file.ts'
import type { ServerStatus } from './refs.ts'

/** One entry of `mcp.servers`: a `url` speaks streamable HTTP, a `command` runs a stdio server. */
export type ServerConfig =
  | { url: string }
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }

/** The tools of one server, as last fetched. */
export type ToolCache = { refreshedAt: string; tools: Tool[] }

type Credentials = {
  redirectPort?: number
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  verifier?: string
  discovery?: OAuthDiscoveryState
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/
/** How long a browser sign-in waits for its redirect. */
const SIGN_IN_MS = 10 * 60 * 1000

/** `mcp.servers` from settings, checked; invalid entries come back as errors and are left out. */
export function parseServers(value: unknown) {
  const servers = new Map<string, ServerConfig>()
  const errors: string[] = []
  if (value === undefined) return { servers, errors }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {
      servers,
      errors: ['mcp.servers must be an object of server name → { url } or { command }'],
    }
  for (const [name, config] of Object.entries(value as Record<string, unknown>)) {
    const entry = config as Record<string, unknown> | null
    const strings = (list: unknown) =>
      Array.isArray(list) && list.every((item) => typeof item === 'string')
    if (!NAME.test(name))
      errors.push(`mcp.servers: "${name}" must use only letters, digits, - and _`)
    else if (entry && typeof entry.url === 'string' && /^https?:\/\//.test(entry.url))
      servers.set(name, { url: entry.url })
    else if (
      entry &&
      typeof entry.command === 'string' &&
      entry.command &&
      (entry.args === undefined || strings(entry.args)) &&
      (entry.cwd === undefined || typeof entry.cwd === 'string') &&
      (entry.env === undefined ||
        (typeof entry.env === 'object' &&
          !Array.isArray(entry.env) &&
          Object.values(entry.env as object).every((item) => typeof item === 'string')))
    )
      servers.set(name, {
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.env ? { env: entry.env as Record<string, string> } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      })
    else
      errors.push(
        `mcp.servers.${name} needs an http(s) "url", or a "command" with optional string "args", "env" and "cwd"`,
      )
  }
  return { servers, errors }
}

/** Where the extension keeps its files: `~/.ultimate/mcp/`. */
export const mcpHome = (userHome: string) => join(userHome, '.ultimate/mcp')
const tokenFile = (userHome: string, name: string) =>
  join(mcpHome(userHome), 'tokens', `${name}.json`)
const cacheFile = (userHome: string, name: string) =>
  join(mcpHome(userHome), 'tools', `${name}.json`)

export const readCache = (userHome: string, name: string) =>
  readJson<ToolCache | undefined>(cacheFile(userHome, name), undefined)

/** The codemode name of a server's tool: `<server>__<tool>`, other characters as `_`. */
export const callName = (server: string, tool: string) =>
  `${server}__${tool.replace(/[^A-Za-z0-9_]/g, '_')}`

/** Credentials, readable only by the user; changes run one at a time per file. */
function credentials(file: string) {
  let queue = Promise.resolve()
  const load = () => readJson<Credentials>(file, {})
  const save = (change: (value: Credentials) => void) => {
    const run = queue.then(async () => {
      const value = await load()
      change(value)
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeJson(file, value, { mode: 0o600 })
    })
    queue = run.catch(() => {
      // The caller receives this failure; later writes must still run.
    })
    return run
  }
  return { load, save }
}

/** A free loopback port, for the redirect URL a client registers once and keeps. */
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  )
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

function oauthProvider(
  file: ReturnType<typeof credentials>,
  port: number,
  state: string,
  redirect: (url: URL) => void,
): OAuthClientProvider {
  const redirectUrl = `http://127.0.0.1:${port}/callback`
  return {
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata() {
      return {
        client_name: 'Ultimate',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }
    },
    state: () => state,
    clientInformation: async () => (await file.load()).client,
    saveClientInformation: (client) => file.save((value) => void (value.client = client)),
    tokens: async () => (await file.load()).tokens,
    saveTokens: (tokens) => file.save((value) => void (value.tokens = tokens)),
    redirectToAuthorization: redirect,
    saveCodeVerifier: (verifier) => file.save((value) => void (value.verifier = verifier)),
    codeVerifier: async () => {
      const verifier = (await file.load()).verifier
      if (!verifier) throw new Error('No OAuth code verifier is saved; connect again')
      return verifier
    },
    saveDiscoveryState: (discovery) => file.save((value) => void (value.discovery = discovery)),
    discoveryState: async () => (await file.load()).discovery,
    invalidateCredentials: (scope) =>
      file.save((value) => {
        if (scope === 'all' || scope === 'client') delete value.client
        if (scope === 'all' || scope === 'tokens') delete value.tokens
        if (scope === 'all' || scope === 'verifier') delete value.verifier
        if (scope === 'all' || scope === 'discovery') delete value.discovery
      }),
  }
}

type Entry = {
  config: ServerConfig
  signature: string
  state: ServerStatus['state']
  error?: string
  authorizationUrl?: string
  client?: Client
  connecting?: Promise<Client>
  /** Ends a pending browser sign-in. */
  cancelSignIn?: () => void
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The live connections of one process, kept across reinstalls. `changed` runs after a server's tool list was fetched,
 * so the facet registers the new tools.
 */
export function createPool(userHome: string) {
  const entries = new Map<string, Entry>()
  const pool = {
    changed: (_server: string) => Promise.resolve(),
    /** Bring the pool in line with the configuration: changed or removed servers are disconnected. */
    async configure(servers: Map<string, ServerConfig>) {
      for (const [name, entry] of entries) {
        const config = servers.get(name)
        if (!config || JSON.stringify(config) !== entry.signature) await drop(name)
      }
      for (const [name, config] of servers)
        if (!entries.has(name))
          entries.set(name, { config, signature: JSON.stringify(config), state: 'idle' })
    },
    async status(name: string): Promise<ServerStatus> {
      const entry = entries.get(name)
      if (!entry) throw new Error(`No MCP server "${name}" is configured`)
      const [cache, file] = await Promise.all([
        readCache(userHome, name),
        credentials(tokenFile(userHome, name)).load(),
      ])
      return {
        name,
        transport: 'url' in entry.config ? 'http' : 'stdio',
        target:
          'url' in entry.config
            ? entry.config.url
            : [entry.config.command, ...(entry.config.args ?? [])].join(' '),
        state: entry.state,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.authorizationUrl ? { authorizationUrl: entry.authorizationUrl } : {}),
        signedIn: !!file.tokens,
        tools: (cache?.tools ?? []).map((tool) => ({
          name: tool.name,
          call: callName(name, tool.name),
          description: tool.description ?? '',
        })),
        ...(cache ? { refreshedAt: cache.refreshedAt } : {}),
      }
    },
    names: () => [...entries.keys()],
    /** The connected client, connecting (and fetching its tools) first when needed. */
    open,
    /** Connect again and fetch the tool list. */
    async refresh(name: string) {
      await drop(name, true)
      await open(name)
    },
    async call(
      name: string,
      tool: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<CallToolResult> {
      const client = await open(name)
      try {
        return await client.callTool({ name: tool, arguments: args }, { signal })
      } catch (error) {
        // A JSON-RPC error is the server's answer; anything else may have broken the connection, so the next call
        // starts a fresh one.
        if (!(error instanceof ProtocolError)) await drop(name, true)
        throw error
      }
    },
    async closeAll() {
      for (const name of entries.keys()) await drop(name)
    },
  }

  async function drop(name: string, keep = false) {
    const entry = entries.get(name)
    if (!entry) return
    entry.cancelSignIn?.()
    const client = entry.client
    delete entry.client
    delete entry.error
    entry.state = 'idle'
    if (!keep) entries.delete(name)
    await client?.close().catch(() => {
      // Closing a connection that already broke has nothing left to release.
    })
  }

  function open(name: string): Promise<Client> {
    const entry = entries.get(name)
    if (!entry) return Promise.reject(new Error(`No MCP server "${name}" is configured`))
    if (entry.client) return Promise.resolve(entry.client)
    if (entry.state === 'authorizing')
      return Promise.reject(
        new Error(
          `MCP server "${name}" waits for the user to sign in at ${entry.authorizationUrl} (or with Connect in the MCP panel).`,
        ),
      )
    entry.connecting ??= connect(name, entry).finally(() => delete entry.connecting)
    return entry.connecting
  }

  async function connect(name: string, entry: Entry) {
    entry.state = 'connecting'
    delete entry.error
    const config = entry.config
    let signIn: (() => Promise<void>) | undefined
    let transport: StreamableHTTPClientTransport | StdioClientTransport
    let stderr = ''
    if ('url' in config) {
      const file = credentials(tokenFile(userHome, name))
      let port = (await file.load()).redirectPort
      if (!port) {
        port = await freePort()
        const chosen = port
        await file.save((value) => void (value.redirectPort = chosen))
      }
      const state = randomBytes(16).toString('base64url')
      const http = new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider: oauthProvider(file, port, state, (url) => {
          entry.authorizationUrl = url.href
        }),
      })
      transport = http
      signIn = () => listen(name, entry, http, port, state, file)
    } else {
      const stdio = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...getDefaultEnvironment(), ...config.env },
        ...(config.cwd ? { cwd: config.cwd } : {}),
        stderr: 'pipe',
      })
      stdio.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-2000)))
      transport = stdio
    }
    const client = new Client({ name: 'ultimate', version: '1.0.0' })
    try {
      await client.connect(transport)
    } catch (error) {
      await client.close().catch(() => {
        // The failed connection may already be closed; the original error is what matters.
      })
      if (signIn && error instanceof UnauthorizedError && entry.authorizationUrl) {
        await signIn()
        throw new Error(
          `MCP server "${name}" needs a sign-in: the user opens ${entry.authorizationUrl} (or Connect in the MCP panel).`,
          { cause: error },
        )
      }
      entry.state = 'error'
      entry.error = [message(error), stderr.trim()].filter(Boolean).join('\n')
      throw new Error(`MCP server "${name}" failed to connect: ${entry.error}`, { cause: error })
    }
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the MCP client has no event target, only this hook.
    client.onclose = () => {
      if (entry.client !== client) return
      delete entry.client
      entry.state = 'idle'
    }
    entry.client = client
    entry.state = 'connected'
    delete entry.authorizationUrl
    try {
      await fetchTools(name, client)
    } catch (error) {
      entry.state = 'error'
      entry.error = message(error)
      throw error
    }
    return client
  }

  async function fetchTools(name: string, client: Client) {
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    const cache: ToolCache = { refreshedAt: new Date().toISOString(), tools }
    await mkdir(dirname(cacheFile(userHome, name)), { recursive: true })
    await writeJson(cacheFile(userHome, name), cache)
    await pool.changed(name)
  }

  /** Wait on the redirect port for the browser to come back with the authorization code. */
  async function listen(
    name: string,
    entry: Entry,
    transport: StreamableHTTPClientTransport,
    port: number,
    state: string,
    file: ReturnType<typeof credentials>,
  ) {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      const page = (status: number, text: string) => {
        response
          .writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
          .end(
            `<!doctype html><title>Ultimate</title><body style="font:15px system-ui;padding:3em">${text}</body>`,
          )
      }
      if (url.pathname !== '/callback') return page(404, 'Not found.')
      if (url.searchParams.get('state') !== state)
        return page(400, 'This sign-in link is stale. Connect again from Ultimate.')
      finish()
      const denied = url.searchParams.get('error')
      if (denied) {
        entry.state = 'needs-auth'
        entry.error = `Sign-in failed: ${url.searchParams.get('error_description') ?? denied}`
        return page(400, `Sign-in failed (${denied}). You can close this tab.`)
      }
      void transport
        .finishAuth(url.searchParams)
        .then(() => {
          entry.state = 'idle'
          return open(name)
        })
        .then(
          () => page(200, `Signed in to ${name}. You can close this tab and return to Ultimate.`),
          (error: unknown) => {
            entry.state = 'error'
            entry.error = message(error)
            page(500, 'Sign-in failed. Ultimate shows the error in its MCP panel.')
          },
        )
    })
    const timer = setTimeout(() => {
      finish()
      entry.state = 'needs-auth'
    }, SIGN_IN_MS)
    function finish() {
      clearTimeout(timer)
      server.close()
      delete entry.cancelSignIn
      delete entry.authorizationUrl
    }
    try {
      await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(port, '127.0.0.1', resolve),
      )
    } catch (error) {
      clearTimeout(timer)
      // Another program holds the port: register a fresh client on a new port next time.
      await file.save((value) => {
        delete value.redirectPort
        delete value.client
      })
      entry.state = 'error'
      entry.error = `The sign-in redirect port ${port} is busy (${message(error)}); connect again.`
      throw new Error(entry.error, { cause: error })
    }
    entry.state = 'authorizing'
    entry.cancelSignIn = () => {
      finish()
      entry.state = 'idle'
    }
  }

  return pool
}
export type Pool = ReturnType<typeof createPool>
