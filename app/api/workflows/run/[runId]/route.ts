import { type NextRequest, NextResponse } from 'next/server'
import { BASE_URL } from 'dify-client'
import { API_KEY, API_URL } from '@/config'

export const dynamic = 'force-dynamic'

/** Query only the configured Dify app; keep its API key on the server. */
export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(params.runId))
    return NextResponse.json({ message: '无效的工作流运行编号。' }, { status: 400 })

  const controller = new AbortController()
  const abort = () => controller.abort()
  request.signal.addEventListener('abort', abort, { once: true })
  if (request.signal.aborted)
    controller.abort()
  const timeout = setTimeout(abort, 15_000)
  try {
    const baseUrl = API_URL && API_URL !== 'undefined' ? API_URL : BASE_URL
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/workflows/run/${encodeURIComponent(params.runId)}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok)
      return NextResponse.json({ message: '暂时无法查询工作流状态，请稍后重试。' }, { status: response.status })
    const data = await response.json()
    if (typeof data.status !== 'string')
      return NextResponse.json({ message: '服务器未返回有效的工作流状态。' }, { status: 502 })
    return NextResponse.json({ id: data.id, status: data.status, outputs: data.outputs, error: data.error }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  catch {
    return NextResponse.json({ message: '暂时无法连接状态查询服务，请稍后重试。' }, { status: 502 })
  }
  finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abort)
  }
}
