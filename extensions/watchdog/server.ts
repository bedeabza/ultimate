import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import {
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryId,
  SubmissionRecord,
  TaskRecord,
  Tx,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { rateLimited } from '../../lib/rate-limit.ts'
import { Messages } from '../messages/api.ts'
import { Standing, Subagents } from '../subagents/api.ts'
import { idleNote } from './idle.ts'
import { WatchdogApi } from './api.ts'
import type { ReportedFailure } from './api.ts'
import type { Failure } from './refs.ts'

/** How long after a temporary failure its one retry starts. */
const RETRY_AFTER = 60_000
/** Reported failures kept for `failures()`; older ones drop off. */
export const FAILURE_LIMIT = 20

const Reported = defineDoc<{ failures: ReportedFailure[] }>({
  kind: 'watchdog.reported',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ failures: [] }),
})

const Receipts = defineDoc<{ highWater?: number; tasks: Record<string, true> }>({
  kind: 'watchdog.receipts',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ tasks: {} }),
})
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const
const LIVE = ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const
/** Live tasks of `kind` in `conversationId`; messages' tasks are matched by kind, so watchdog needs no import of them. */
async function live(tx: Tx, kind: string, conversationId: ConversationId) {
  const found = []
  for (const status of LIVE) {
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanTasks({ conversationId, kind, status }, 100, cursor)
      found.push(...page.items)
      cursor = page.next
    } while (cursor)
  }
  return found
}
/** Hands @ultimate the idle note its turn ended with: a branch still waits on its answer. */
const Owed = defineTask<
  { ultimate: ConversationId; data: { ids: number[]; text: string } },
  { phase: 'submit' },
  null
>({
  name: 'watchdog.owed',
  version: 1,
  initial: () => ({ phase: 'submit' }),
  phases: {
    submit: async (task, runtime, ctx) => {
      await (await runtime.conversation(task.input.ultimate, ctx))!.submit(
        {
          type: 'input',
          content: task.input.data.text,
          entry: { kind: 'watchdog.idle', data: task.input.data },
          requestId: `watchdog-owed:${task.id}`,
          whenBusy: 'followUp',
        },
        ctx,
      )
      await runtime.commit(() => terminal, ctx)
    },
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})
const failed = (task: TaskRecord<JsonValue, JsonValue, JsonValue>) =>
  task.kind === GenerationTask.definition.name &&
  task.state.status === 'terminal' &&
  task.state.outcome.status === 'failed' &&
  ['model_error', 'no_model'].includes(
    (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason ?? '',
  )
const failedInput = (input: SubmissionRecord) =>
  input.type === 'input' &&
  input.status === 'unanswered' &&
  ['model_error', 'no_model'].includes(input.reason)

/** The final error entry of a generation, excluding any later run. Pi can append several
 * assistant errors during its internal retries; only the last one ended the run. */
async function boundary(tx: Tx, task: Generation, next?: Generation) {
  let upper = Number(task.id)
  let assistant: AssistantMessage | undefined
  if (
    task.state.status === 'terminal' &&
    task.state.outcome.status === 'failed' &&
    (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason === 'model_error'
  ) {
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanEntries(
        {
          conversationId: task.conversationId,
          minEntryId: task.id as number as EntryId,
          ...(next ? { maxEntryId: (next.id - 1) as EntryId } : {}),
          order: 'descending',
        },
        100,
        cursor,
      )
      const entry = page.items.find((candidate) => candidate.model?.[0]?.role === 'assistant')
      const message = entry?.model?.[0]
      if (message?.role === 'assistant') {
        if (message.stopReason === 'error') {
          upper = entry!.id
          assistant = message
        }
        break
      }
      cursor = page.next
    } while (cursor)
  }
  return { upper, assistant }
}

/**
 * What a failed run's error asks for: a broken login needs the user, so it reports at once with a hint to log in again;
 * a rate limit that outlasted Pi's retries reports once and never re-prompts into the limit; an
 * incomplete Claude Code relay response (status 200 or unknown) is a dropped stream, so it retries like Pi's own
 * retryable errors.
 */
export function diagnose(error: string, assistant?: AssistantMessage) {
  if (rateLimited(error))
    return {
      hint: 'Still rate limited after Pi’s retries; once the limit resets (or the agent has another model), resume this conversation with a message',
      temporary: false,
    }
  if (/not logged in/i.test(error))
    return { hint: 'Run `claude auth login` in a terminal', temporary: false }
  // The conversation's model has no login here; its next input switches it to one that has.
  const missing = /Provider is not configured: ([\w-]+)|No API key (?:found )?for "?([\w-]+)/i.exec(
    error,
  )
  if (missing)
    return {
      hint: `${missing[1] ?? missing[2]} has no login here. Log in again (⌘K → Log in to a provider), or message the conversation: its next run switches to a model that has one`,
      temporary: false,
    }
  const provider = /OAuth refresh failed for ([\w-]+)/i.exec(error)?.[1] ?? assistant?.provider
  if (/OAuth refresh failed|invalid_grant/i.test(error))
    return {
      hint: `Log in to ${provider ?? 'the provider'} again: ⌘K → Log in to a provider`,
      temporary: false,
    }
  return {
    temporary:
      /^Incomplete Claude Code upstream response \(status (200|unknown),/.test(error) ||
      !!(assistant && isRetryableAssistantError(assistant)),
  }
}

type Generation = TaskRecord<JsonValue, JsonValue, JsonValue>
/** Live commits give us the exact settled inputs. On reopen, only model_error/no_model
 * submissions matter: their entries lie between consecutive failed-run boundaries.
 * Successful and stopped runs cannot match that filter. No-model has no assistant entry,
 * so its generation ID supplies its boundary. All IDs share one allocation order. */
async function details(tx: Tx, metadata: ExtensionHost['metadata'], task: Generation) {
  const generations: Generation[] = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanTasks(
      { conversationId: task.conversationId, kind: GenerationTask.definition.name },
      500,
      cursor,
    )
    generations.push(...page.items)
    cursor = page.next
  } while (cursor)
  const index = generations.findIndex((candidate) => candidate.id === task.id)
  const previous = generations.findLastIndex(
    (candidate) => candidate.id < task.id && failed(candidate),
  )
  const { upper, assistant } = await boundary(tx, task, generations[index + 1])
  const lower =
    previous < 0 ? 0 : (await boundary(tx, generations[previous], generations[previous + 1])).upper
  let step = 'model request'
  cursor = undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: task.conversationId, maxEntryId: upper as EntryId },
      100,
      cursor,
    )
    for (const entry of page.items) {
      const message = entry.model?.[0]
      const call =
        message?.role === 'assistant' &&
        message.content.findLast((part) => part.type === 'toolCall')
      if (call && call.type === 'toolCall') {
        step = call.name
        break
      }
    }
    cursor = page.next
  } while (cursor && step === 'model request')
  const title = (await tx.doc(metadata, task.conversationId)).title ?? 'Untitled'
  return { upper, lower, step, assistant, title }
}

export default function watchdog(host: ExtensionHost) {
  const Watchdog = defineTask<
    Failure & { failedTask: number; recipient: ConversationId; temporary: boolean; until: number },
    { phase: 'wait' } | { phase: 'retry' } | { phase: 'report' },
    null
  >({
    name: 'watchdog.failure',
    version: 1,
    initial: (input) => ({ phase: input.temporary && !input.retried ? 'wait' : 'report' }),
    phases: {
      wait: (task, runtime, ctx) => runtime.sleepUntil(task.input.until, { phase: 'retry' }, ctx),
      retry: async (task, runtime, ctx) => {
        const { conversation, failedTask, error } = task.input
        const child = (await runtime.conversation(conversation as ConversationId, ctx))!
        // A replay after submit must finish, not mistake its own retry for someone else's recovery.
        let submitted = false
        let busy = false
        await runtime.commit(async (tx) => {
          submitted = !!(await tx.submissionByRequest(child.id, `watchdog-retry:${failedTask}`))
          busy = (await tx.doc(LiveDoc, child.id)).run !== undefined
        }, ctx)
        if (!submitted && !busy)
          await child.submit(
            {
              type: 'input',
              content: `Your previous run stopped with a provider error (${error}). Continue from where you left off; check what you already did and do not redo it.`,
              requestId: `watchdog-retry:${failedTask}`,
              whenBusy: 'followUp',
            },
            ctx,
          )
        await runtime.commit(() => terminal, ctx)
      },
      report: async (task, runtime, ctx) => {
        const { conversation, title, error, step, hint, retried, failedTask, recipient } =
          task.input
        const data: Failure = {
          conversation,
          title,
          error,
          step,
          retried,
          ...(hint ? { hint } : {}),
        }
        const content = `[run failed] #${conversation} "${title}": ${error}. Last step: ${step}.${retried ? ' After one automatic retry.' : ''}${hint ? ` ${hint}.` : ''}`
        if (recipient === conversation) {
          // Notices are process-local diagnostics, not submissions; a reopened facet retains no old notice.
          host.notice(content)
        } else {
          const target = (await runtime.conversation(recipient, ctx))!
          await target.submit(
            {
              type: 'input',
              content: `${content}\nCheck the conversation; resume it with a message, or tell the user if it needs them.`,
              entry: { kind: 'watchdog.failure', data },
              requestId: `watchdog-report:${failedTask}`,
              whenBusy: 'steer',
            },
            ctx,
          )
        }
        await runtime.commit(async (tx) => {
          const reported = await tx.doc(Reported, ROOT_CONVERSATION_ID)
          // Newest first by when the run failed: reports of older failures can finish later.
          reported.failures.push({ ...data, at: task.input.until - RETRY_AFTER })
          reported.failures.sort((a, b) => b.at - a.at)
          reported.failures.splice(FAILURE_LIMIT)
          // Reporting ends the watchdog's hold on a subagent's provider failure: its action has given up.
          const actions = Object.values((await tx.doc(Subagents, recipient)).actions)
          const action = actions.findLast((candidate) => candidate.conversationId === conversation)
          if (action?.status === 'failed') {
            const input = await tx.submissionByRequest(
              conversation as ConversationId,
              `subagent:${action.reporter}`,
            )
            if (input && failedInput(input)) action.status = 'given-up'
          }
          return terminal
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

  async function detect(
    task: TaskRecord<JsonValue, JsonValue, JsonValue>,
    inputs?: SubmissionRecord[],
  ) {
    if (!failed(task)) return
    let submissions = inputs
    if (!submissions) {
      submissions = []
      let cursor: Cursor | undefined
      do {
        const page = await host.scanSubmissions(
          { conversationId: task.conversationId, status: 'unanswered' },
          500,
          cursor,
          context,
        )
        submissions.push(...page.items.filter(failedInput))
        cursor = page.next
      } while (cursor)
    }
    await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      if (task.id <= (receipts.highWater ?? Infinity) || receipts.tasks[String(task.id)]) return
      const info = await details(tx, host.metadata, task)
      const runInputs = submissions.filter(
        (input) =>
          failedInput(input) &&
          input.entry !== undefined &&
          (inputs !== undefined || (input.entry > info.lower && input.entry <= info.upper)),
      )
      receipts.tasks[String(task.id)] = true
      const messages = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
      if (
        runInputs.some((input) => {
          const match = /^board:(\d+)$/.exec(input.requestId ?? '')
          return (
            match && messages.some((message) => message.id === Number(match[1]) && message.reply)
          )
        })
      )
        return
      const child = (await tx.conversation(task.conversationId))!
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      const recipient = child.owner?.conversationId ?? ultimate
      if (recipient === undefined)
        throw new Error('Watchdog needs @ultimate to report a failed run')
      if (task.state.status !== 'terminal' || task.state.outcome.status !== 'failed') return
      const error = task.state.outcome.error.message
      const { hint, temporary } = diagnose(error, info.assistant)
      await tx.createTask(
        Watchdog,
        {
          failedTask: task.id,
          conversation: child.id,
          recipient,
          title: info.title,
          error,
          step: info.step,
          ...(hint ? { hint } : {}),
          retried: runInputs.some((input) => input.requestId?.startsWith('watchdog-retry:')),
          temporary,
          until: (task.endedAt ?? Date.now()) + RETRY_AFTER,
        },
        { conversationId: recipient, ownership: { kind: 'conversation' }, background: true },
      )
    }, context)
  }

  /**
   * Once @ultimate (`candidate`) is idle, its answers routed down and its replies delivered, a branch still waiting on
   * its answer gets an idle note that wakes it.
   */
  const turnEnded = async (candidate: number) => {
    // Most commits are other conversations': a snapshot skips them without a write.
    if (
      (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate !==
      candidate
    )
      return
    await host.harness().commit(async (tx) => {
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      if (ultimate === undefined || ultimate !== candidate) return
      if ((await tx.doc(LiveDoc, ultimate)).run || (await tx.doc(InboxDoc, ultimate)).items.length)
        return
      if ((await live(tx, 'board.route', ultimate)).length) return
      const deliveries = await live(tx, 'board.delivery', ROOT_CONVERSATION_ID)
      if (
        deliveries.some((task) => {
          const { message, note } = task.input as { message?: { to?: unknown }; note?: boolean }
          return message?.to === ultimate && !note
        })
      )
        return
      const note = await idleNote(tx, host, ultimate, Date.now(), true)
      if (note)
        await tx.createTask(
          Owed,
          { ultimate, data: note.entries[0].data },
          { conversationId: ultimate, ownership: { kind: 'conversation' }, background: true },
        )
    }, context)
  }

  let unsubscribe: (() => void) | undefined
  let recovery = Promise.resolve()
  const close = async () => {
    unsubscribe?.()
    unsubscribe = undefined
    await recovery
  }
  host.onClose(close)
  host.onRelease(close)
  host.implement(WatchdogApi, {
    failures: async (since) =>
      (
        (await host.harness().snapshot(Reported, ROOT_CONVERSATION_ID, context))?.failures ?? []
      ).filter((failure) => failure.at >= since),
  })
  host.onOpen(async () => {
    unsubscribe?.()
    unsubscribe = onCommit(host.harness(), (publication) => {
      const inputs = publication.changes.flatMap((change) =>
        change.type === 'submission' && failedInput(change.value) ? [change.value] : [],
      )
      for (const change of publication.changes) {
        // A run ending, or a route or delivery finishing after it, may be the end of @ultimate's turn.
        const ended =
          change.type === 'document'
            ? change.kind === 'change' &&
              change.record.kind === LiveDoc.definition.kind &&
              !change.value.run &&
              change.conversationId
            : change.type === 'task' &&
              change.value.state.status === 'terminal' &&
              (change.value.kind === 'board.route'
                ? change.value.conversationId
                : change.value.kind === 'board.delivery' &&
                  (change.value.input as { message?: { to?: unknown } }).message?.to)
        if (typeof ended === 'number')
          recovery = recovery
            .then(() => turnEnded(ended))
            .catch((error: unknown) => host.notice(`Watchdog turn check failed: ${String(error)}`))
        if (change.type !== 'task' || !failed(change.value)) continue
        recovery = recovery
          .then(() =>
            detect(
              change.value,
              inputs.filter((input) => input.conversationId === change.value.conversationId),
            ),
          )
          .catch((error: unknown) => host.notice(`Watchdog recovery failed: ${String(error)}`))
      }
    })
    const tasks = await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      if (receipts.highWater === undefined) {
        let newest = 0
        let unfinished = Infinity
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanTasks({}, 500, cursor)
          for (const task of page.items) {
            newest = task.id
            if (task.state.status !== 'terminal') unfinished = Math.min(unfinished, task.id)
            // Terminal failures are historical even when a still-running older task holds the mark back.
            if (failed(task)) receipts.tasks[String(task.id)] = true
          }
          cursor = page.next
        } while (cursor)
        receipts.highWater = unfinished === Infinity ? newest : unfinished - 1
        return []
      }
      const all = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ order: 'descending' }, 500, cursor)
        all.push(...page.items.filter((task) => task.id > receipts.highWater!))
        cursor = (page.items.at(-1)?.id ?? 0) > receipts.highWater ? page.next : undefined
      } while (cursor)
      return all.toReversed()
    }, context)
    for (const task of tasks) await detect(task)
    // Do not pass unfinished tasks: an older run can fail after a newer one, even across restart.
    await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      for (const task of tasks) {
        if (task.state.status !== 'terminal') break
        receipts.highWater = task.id
      }
    }, context)
  })
  return defineExtension({
    name: 'watchdog',
    tasks: [Watchdog, Owed],
    hooks: [
      hook(GenerationTask, {
        beforeInput: async (_input, { tx, conversationId }) =>
          (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === conversationId
            ? idleNote(tx, host, conversationId, Date.now())
            : undefined,
      }),
    ],
  })
}
