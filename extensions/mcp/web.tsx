import { ChevronRightIcon, ExternalLinkIcon, LoaderCircleIcon, PlugIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  formatAgo,
  useAction,
  useNow,
  useSystem,
} from '@/sdk'
import { ConnectAction, RefreshAction, StatusAction } from './refs.ts'
import type { ServerStatus } from './refs.ts'

const dot = (tone: string) => <span className={cn('size-1.5 shrink-0 rounded-full', tone)} />
const small = 'h-7 gap-1.5 px-2 font-mono text-[11.5px]'

const states: Record<ServerStatus['state'], { label: string; tone: string; text: string }> = {
  idle: { label: 'not connected', tone: 'bg-muted-foreground/50', text: 'text-muted-foreground' },
  connecting: {
    label: 'connecting',
    tone: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
  },
  connected: { label: 'connected', tone: 'bg-success', text: 'text-muted-foreground' },
  authorizing: { label: 'waiting for sign-in', tone: 'bg-warning', text: 'text-warning' },
  'needs-auth': { label: 'needs sign-in', tone: 'bg-warning', text: 'text-warning' },
  error: { label: 'failed', tone: 'bg-error', text: 'text-error' },
}

/**
 * The servers, read on mount, after each reinstall of the server facet (a settings change or a new tool list), and
 * every two seconds while a server connects or waits for a browser sign-in.
 */
function useServers() {
  const system = useSystem()
  const servers = useAction(StatusAction, null, { onError: () => {} })
  const loadedAt = system?.extensions.find((extension) => extension.name === 'mcp')?.server
    ?.loadedAt
  const seen = useRef(loadedAt)
  const { refetch, data } = servers
  useEffect(() => {
    if (loadedAt === seen.current) return
    seen.current = loadedAt
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [loadedAt, refetch])
  const pending = data?.some(
    (server) => server.state === 'authorizing' || server.state === 'connecting',
  )
  useEffect(() => {
    if (!pending) return undefined
    const timer = setInterval(() => void refetch(), 2000)
    return () => clearInterval(timer)
  }, [pending, refetch])
  return servers
}

function Heading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 section-label">
      {children}
      {meta !== undefined && <span className="ml-auto flex items-center gap-1.5">{meta}</span>}
    </div>
  )
}

function Row({
  server,
  now,
  onChange,
}: {
  server: ServerStatus
  now: number
  onChange: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  const state = states[server.state]
  const run = async (connect: boolean) => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await api.action(connect ? ConnectAction : RefreshAction, {
        server: server.name,
      })
      // The sign-in page opens in a new tab; a blocked pop-up leaves the link in the row.
      if (next.authorizationUrl) window.open(next.authorizationUrl, '_blank', 'noopener')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
      onChange()
    }
  }
  const connected = server.state === 'connected'
  return (
    <li aria-label={server.name} className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
          {server.name}
        </span>
        <span
          className={cn('flex shrink-0 items-center gap-1.5 font-mono text-[11px]', state.text)}
        >
          {server.state === 'connecting' ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : (
            dot(state.tone)
          )}
          {state.label}
        </span>
      </div>
      <p
        className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/75"
        title={server.target}
      >
        {server.transport === 'http' ? server.target : `$ ${server.target}`}
      </p>
      {server.error && (
        <p className="mt-1 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap text-error">
          {server.error}
        </p>
      )}
      {server.authorizationUrl && (
        <a
          className="mt-1 inline-flex items-center gap-1 text-[12px] text-brand outline-none hover:underline focus-visible:underline"
          href={server.authorizationUrl}
          rel="noreferrer"
          target="_blank"
        >
          Open the sign-in page
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <Button
          className={small}
          disabled={busy || server.state === 'connecting'}
          onClick={() => void run(!connected)}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          {connected ? 'Refresh' : server.state === 'authorizing' ? 'Retry sign-in' : 'Connect'}
        </Button>
        {server.tools.length > 0 && (
          <button
            aria-expanded={open}
            className="ml-auto flex items-center gap-1 rounded font-mono text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpen(!open)}
            type="button"
          >
            <ChevronRightIcon className={cn('size-3 transition-transform', open && 'rotate-90')} />
            {server.tools.length} tools
            {server.refreshedAt && (
              <span className="text-muted-foreground/60">
                {' '}
                · {formatAgo(Date.parse(server.refreshedAt), now, { ago: true })}
              </span>
            )}
          </button>
        )}
      </div>
      {error && <p className="mt-1 font-mono text-[11px] leading-snug text-error">{error}</p>}
      {open && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {server.tools.map((tool) => (
            <li key={tool.name} className="min-w-0">
              <div
                className="truncate font-mono text-[11.5px] text-foreground/90"
                title={`tools.${tool.call}`}
              >
                {tool.name}
              </div>
              {tool.description && (
                <p className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">
                  {tool.description}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function McpPanel() {
  const { data, error, loading, refetch } = useServers()
  const now = useNow(30000)
  const connected = data?.filter((server) => server.state === 'connected').length ?? 0
  const meta =
    loading && !data ? (
      <LoaderCircleIcon className="size-3 animate-spin" />
    ) : data?.length ? (
      <span className="text-muted-foreground/70">
        {connected}/{data.length} connected
      </span>
    ) : undefined
  return (
    <section className="pt-3 pb-3.5">
      <Heading meta={meta}>MCP servers</Heading>
      {error && (
        <p className="mx-3 mt-2.5 font-mono text-[11px] leading-snug break-words text-error">
          {errorMessage(error)}
        </p>
      )}
      {data && data.length === 0 && (
        <p className="mx-3 mt-2.5 text-[12.5px] leading-snug text-muted-foreground">
          No servers yet. Add them under <span className="font-mono">mcp.servers</span> in{' '}
          <span className="font-mono">~/.ultimate/settings.json</span>.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="mt-2 divide-y divide-border/70 border-y border-border/70">
          {data.map((server) => (
            <Row key={server.name} now={now} onChange={() => void refetch()} server={server} />
          ))}
        </ul>
      )}
      <p className="mx-3 mt-3 text-[11.5px] leading-snug text-muted-foreground/80">
        Configured in <span className="font-mono">~/.ultimate/settings.json</span>; sign-ins stay in{' '}
        <span className="font-mono">~/.ultimate/mcp/tokens/</span>, readable only by your user.
      </p>
    </section>
  )
}

export default defineWebExtension({
  panels: [{ id: 'mcp', title: 'MCP', icon: PlugIcon, component: McpPanel, order: 8 }],
  commands: [
    { id: 'mcp.panel', title: 'MCP servers…', run: (context) => context.openPanel('mcp') },
  ],
})
