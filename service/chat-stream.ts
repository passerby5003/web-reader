/** Read Dify SSE messages without depending on chunk or newline boundaries. */
export async function readChatStream(response: Response, onText: (text: string) => void) {
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.message || `请求失败（${response.status}），请稍后重试。`)
  }
  if (!response.body)
    throw new Error('服务器未返回内容，请重试。')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let finished = false
  const processEvent = (block: string) => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]')
      return
    const event = JSON.parse(data)
    if (event.event === 'error' || event.error)
      throw new Error(event.message || event.error || '生成失败，请重试。')
    if (event.event === 'message' || event.event === 'text_chunk') {
      answer += event.answer ?? event.data?.text ?? ''
      onText(answer)
    }
    if (event.event === 'workflow_finished') {
      if (event.data?.error || event.data?.status === 'failed' || event.data?.status === 'stopped')
        throw new Error(event.data.error || '工作流未能完成，请重试。')
      const outputs = event.data?.outputs
      if (outputs && Object.keys(outputs).length) {
        const values = Object.values(outputs)
        answer = values.length === 1
          ? (typeof values[0] === 'string' ? values[0] : JSON.stringify(values[0], null, 2))
          : Object.entries(outputs).map(([key, value]) => `### ${key}\n\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`).join('\n\n')
        onText(answer)
      }
      finished = true
    }
    if (event.event === 'message_end')
      finished = true
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        processEvent(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      if (done || finished) {
        if (buffer.trim() && !finished)
          processEvent(buffer)
        break
      }
    }
    if (!answer.trim())
      throw new Error('服务器没有返回可显示的内容，请重试。')
    return answer
  }
  finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
