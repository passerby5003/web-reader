export type WorkflowRunDetail = {
  id?: string
  status: string
  outputs?: Record<string, unknown> | null
  error?: string | null
}

export type ChatStreamOptions = {
  signal?: AbortSignal
  getWorkflowRun?: (runId: string, signal?: AbortSignal) => Promise<WorkflowRunDetail>
  onWaiting?: (message: string) => void
  idleTimeoutMs?: number
  pollIntervalMs?: number
}

export const WORKFLOW_RUNNING_MESSAGE = '服务器正在运行中，请稍等。'
export const WORKFLOW_STATUS_UNAVAILABLE_MESSAGE = '暂时无法查询服务器状态，正在重试，请稍等。'

export function formatWorkflowOutputs(outputs?: Record<string, unknown> | null) {
  if (!outputs || !Object.keys(outputs).length)
    return '工作流已完成，但没有返回可显示的内容或文件。请检查节点的输出配置。'
  const values = Object.values(outputs)
  const format = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''
  return values.length === 1
    ? format(values[0])
    : Object.entries(outputs).map(([key, value]) => `### ${key}\n\n${format(value)}`).join('\n\n')
}

/** A timeout leaves the original read alive, so status checks never restart a workflow. */
function waitForRead<T>(read: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | 'idle'> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(new DOMException('已停止等待', 'AbortError'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve('idle')
    }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    read.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException('已停止等待', 'AbortError')
}

/** Read Dify SSE and recover long or disconnected workflows by querying their run ID. */
export async function readChatStream(response: Response, onText: (text: string) => void, options: ChatStreamOptions = {}) {
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.message || `请求失败（${response.status}），请稍后重试。`)
  }
  if (!response.body)
    throw new Error('服务器未返回内容，请重试。')

  const { signal, getWorkflowRun, onWaiting, idleTimeoutMs = 60_000, pollIntervalMs = 5_000 } = options
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let finished = false
  let runId = ''
  let streamClosed = false
  let polling = false
  let nextStatusCheckAt = Date.now() + idleTimeoutMs
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined

  const finishWorkflow = (detail: WorkflowRunDetail) => {
    if (detail.status === 'failed')
      throw new Error(detail.error || '工作流执行失败，服务器没有返回可显示的内容。')
    if (detail.status === 'stopped') {
      const error = new Error(detail.error || '工作流已停止。')
      error.name = 'WorkflowStoppedError'
      throw error
    }
    if (detail.status === 'succeeded' || detail.status === 'partial-succeeded') {
      answer = formatWorkflowOutputs(detail.outputs)
      if (!answer.trim())
        answer = '工作流已完成，但返回的内容为空。请检查节点的输出配置。'
      onText(answer)
      finished = true
    }
  }

  const checkWorkflow = async () => {
    throwIfAborted(signal)
    if (!runId || !getWorkflowRun) {
      onWaiting?.('暂未收到运行编号，正在等待服务器响应，请稍等。')
      return
    }
    let detail: WorkflowRunDetail
    try {
      detail = await getWorkflowRun(runId, signal)
    }
    catch {
      throwIfAborted(signal)
      // A failed status request does not mean the workflow itself failed.
      onWaiting?.(WORKFLOW_STATUS_UNAVAILABLE_MESSAGE)
      return
    }
    throwIfAborted(signal)
    finishWorkflow(detail)
    if (!finished)
      onWaiting?.(detail.status === 'running' ? WORKFLOW_RUNNING_MESSAGE : '任务尚未结束，正在等待服务器确认状态，请稍等。')
  }

  const processEvent = (block: string) => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]')
      return
    const event = JSON.parse(data)
    // Heartbeats keep the transport alive but do not mean the task made progress.
    if (event.event !== 'ping')
      nextStatusCheckAt = Date.now() + (polling ? pollIntervalMs : idleTimeoutMs)
    if (typeof event.workflow_run_id === 'string')
      runId = event.workflow_run_id
    else if (event.event === 'workflow_started' && typeof event.data?.id === 'string')
      runId = event.data.id
    if (event.event === 'error' || event.error)
      throw new Error(event.message || event.error || '生成失败，请重试。')
    if (event.event === 'message' || event.event === 'text_chunk') {
      answer += event.answer ?? event.data?.text ?? ''
      onText(answer)
    }
    if (event.event === 'workflow_finished')
      finishWorkflow({ ...event.data, status: event.data?.status || (event.data?.error ? 'failed' : 'succeeded') })
    if (event.event === 'message_end')
      finished = true
  }

  try {
    while (!finished) {
      throwIfAborted(signal)
      if (streamClosed) {
        // The transport can end while the job continues on Dify's workers.
        await checkWorkflow()
        if (!finished)
          await waitForRead(new Promise<never>(() => { }), pollIntervalMs, signal)
        continue
      }
      pendingRead ??= reader.read()
      let result: ReadableStreamReadResult<Uint8Array> | 'idle'
      try {
        result = await waitForRead(pendingRead, Math.max(1, nextStatusCheckAt - Date.now()), signal)
      }
      catch (error) {
        throwIfAborted(signal)
        if (!runId || !getWorkflowRun)
          throw error
        streamClosed = true
        continue
      }
      if (result === 'idle') {
        await checkWorkflow()
        polling = true
        nextStatusCheckAt = Date.now() + pollIntervalMs
        continue
      }
      pendingRead = undefined
      buffer = (buffer + decoder.decode(result.value, { stream: !result.done })).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1 && !finished) {
        processEvent(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      if (result.done) {
        if (buffer.trim() && !finished)
          processEvent(buffer)
        if (!finished && runId && getWorkflowRun) {
          streamClosed = true
          continue
        }
        break
      }
    }
    if (!answer.trim())
      throw new Error(getWorkflowRun && !runId
        ? '连接已结束，但未收到工作流运行编号，暂时无法确认后台状态。请先查看运行记录。'
        : '服务器没有返回可显示的内容，请重试。')
    return answer
  }
  finally {
    // Do not wait for an unresponsive server before releasing the UI's Stop button.
    void reader.cancel().catch(() => { })
    reader.releaseLock()
  }
}
