'use client'

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowDownIcon, ArrowPathIcon, ArrowRightIcon, ArrowUpIcon,
  Bars3Icon, CheckIcon, ChevronDownIcon, ClipboardDocumentIcon,
  DocumentTextIcon, GlobeAltIcon, MoonIcon, PencilSquareIcon,
  PlusIcon, SparklesIcon, StopIcon, SunIcon, TrashIcon, XMarkIcon,
} from '@heroicons/react/24/outline'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, Conversation } from './history'
import { newConversation, restoreConversations } from './history'
import './workspace.css'
import { API_PREFIX, APP_ID, IS_WORKFLOW } from '@/config'
import type { PromptVariable } from '@/types/app'
import { userInputsFormToPromptVariables } from '@/utils/prompt'
import { readChatStream } from '@/service/chat-stream'

const APP_NAME = 'Web Conclusion'
const MAX_LENGTH = 1024
const HISTORY_KEY = `web-conclusion:history:${APP_ID}`
const THEME_KEY = 'web-conclusion:theme'
const SIDEBAR_KEY = 'web-conclusion:sidebar'
const suggestions = [
  { icon: GlobeAltIcon, title: '读懂一篇网页', detail: '提炼核心观点，快速掌握重点', prompt: '请总结这个网页的主要内容与核心观点：\n' },
  { icon: DocumentTextIcon, title: '梳理一段内容', detail: '把长篇文字整理成清晰的摘要', prompt: '请将以下内容整理成结构清晰的摘要：\n' },
  { icon: SparklesIcon, title: '发现关键洞察', detail: '从信息中提取值得关注的结论', prompt: '请分析以下内容，提取关键结论和可采取的行动：\n' },
]

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`wc-brand-mark ${small ? 'wc-brand-mark-small' : ''}`} aria-hidden="true"><GlobeAltIcon /></span>
}

function Message({ message, onRetry }: { message: ChatMessage; onRetry: () => void }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  useEffect(() => {
    if (!copied)
      return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setCopyError(false)
    }
    catch {
      setCopyError(true)
    }
  }
  if (message.role === 'user') {
    return <article className="wc-user-message" aria-label="你的消息"><div>{message.content}</div></article>
  }
  return (
    <article className="wc-assistant-message" aria-label="Web Conclusion 的回复" aria-busy={message.status === 'pending'}>
      <BrandMark small />
      <div className="wc-answer">
        <div className="wc-answer-label">{APP_NAME}{message.status === 'pending' && <span>正在整理</span>}</div>
        {message.content && <div className="wc-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} linkTarget="_blank">{message.content}</ReactMarkdown></div>}
        {message.status === 'pending' && !message.content && <div className="wc-thinking" role="status" aria-label="正在生成回复"><i /><i /><i /></div>}
        {message.status === 'pending' && message.waitingMessage && <p className="wc-waiting-message" role="status">{message.waitingMessage}</p>}
        {message.status === 'error' && <div className="wc-message-error" role="alert"><p>{message.error || '生成失败，请重试。'}</p><button type="button" onClick={onRetry}><ArrowPathIcon />重新发送</button></div>}
        {message.status === 'stopped' && <p className="wc-muted wc-stopped">已停止生成</p>}
        {message.content && message.status !== 'pending' && (
          <div className="wc-message-actions"><button type="button" className="wc-icon-button" aria-label={copied ? '已复制' : '复制回复'} title={copied ? '已复制' : '复制回复'} onClick={copy}>{copied ? <CheckIcon /> : <ClipboardDocumentIcon />}</button><span>{copied ? '已复制' : copyError ? '复制失败，请手动选择内容复制' : ''}</span></div>
        )}
      </div>
    </article>
  )
}

export default function ChatWorkspace() {
  const [chats, setChats] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [draft, setDraft] = useState('')
  const [variables, setVariables] = useState<PromptVariable[]>([])
  const [extraInputs, setExtraInputs] = useState<Record<string, string>>({})
  const [configState, setConfigState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [configError, setConfigError] = useState('')
  const [storageError, setStorageError] = useState('')
  const [runningChat, setRunningChat] = useState<string | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followScroll = useRef(true)
  const requestRef = useRef<AbortController | null>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const activeChat = chats.find(chat => chat.id === activeId)
  const messages = activeChat?.messages || []
  const hasMessages = messages.length > 0
  const inputVariable = variables.find(variable => variable.key === 'user_input' || variable.name === 'user_input')
    || variables.find(variable => ['string', 'paragraph'].includes(variable.type))
  const otherVariables = variables.filter(variable => variable !== inputVariable)

  const loadConfig = useCallback(async (signal?: AbortSignal) => {
    setConfigState('loading')
    try {
      const response = await fetch(`${API_PREFIX}/parameters`, { credentials: 'include', signal })
      if (!response.ok)
        throw new Error('无法加载应用配置，请检查服务连接。')
      const params = await response.json()
      if (!Array.isArray(params.user_input_form))
        throw new Error('暂时无法加载输入配置，请检查 Dify 服务后重试。')
      const nextVariables = userInputsFormToPromptVariables(params.user_input_form)
      if (!nextVariables.some(variable => ['string', 'paragraph'].includes(variable.type)))
        throw new Error('应用中未配置文本输入变量，请检查 Dify 表单配置。')
      setVariables(nextVariables)
      setConfigState('ready')
      setConfigError('')
    }
    catch (error) {
      if (signal?.aborted)
        return
      setConfigError(error instanceof Error ? error.message : '加载配置失败，请重试。')
      setConfigState('error')
    }
  }, [])

  useEffect(() => {
    document.title = APP_NAME
    const controller = new AbortController()
    void loadConfig(controller.signal)
    try {
      const savedTheme = localStorage.getItem(THEME_KEY)
      setTheme(savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light')
      setSidebarOpen(window.innerWidth > 760 && localStorage.getItem(SIDEBAR_KEY) !== 'closed')
      const history = restoreConversations(localStorage.getItem(HISTORY_KEY))
      setChats(history)
      const savedActiveId = localStorage.getItem(`${HISTORY_KEY}:active`)
      setActiveId(history.find(chat => chat.id === savedActiveId)?.id || null)
    }
    catch {
      setStorageError('浏览器未能读取历史记录；你仍可开始新对话。')
    }
    setReady(true)
    return () => {
      controller.abort()
      requestRef.current?.abort()
    }
  }, [loadConfig])

  useEffect(() => {
    if (!ready)
      return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(chats))
        localStorage.setItem(`${HISTORY_KEY}:active`, activeId || '')
        localStorage.setItem(THEME_KEY, theme)
        localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? 'open' : 'closed')
      }
      catch {
        setStorageError('浏览器存储空间不足或不可用，当前对话可能无法在刷新后保留。')
      }
    }, 250)
    const saveOnLeave = () => {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(chats))
        localStorage.setItem(`${HISTORY_KEY}:active`, activeId || '')
      }
      catch { }
    }
    window.addEventListener('pagehide', saveOnLeave)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pagehide', saveOnLeave)
    }
  }, [chats, activeId, theme, sidebarOpen, ready])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea)
      return
    const resize = () => {
      textarea.style.height = '0px'
      const height = Math.min(textarea.scrollHeight, 224)
      textarea.style.height = `${Math.max(height, 56)}px`
      textarea.style.overflowY = textarea.scrollHeight > 224 ? 'auto' : 'hidden'
    }
    resize()
    let width = textarea.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width
      if (nextWidth !== width) {
        width = nextWidth
        resize()
      }
    })
    const container = textarea.parentElement
    if (container)
      observer.observe(container)
    return () => observer.disconnect()
  }, [draft, sidebarOpen])

  useEffect(() => {
    followScroll.current = true
    setShowScrollButton(false)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [activeId])

  useEffect(() => {
    if (followScroll.current)
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!sidebarOpen || window.innerWidth > 760)
      return
    const firstButton = sidebarRef.current?.querySelector('button')
    firstButton?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false)
        toggleRef.current?.focus()
      }
      if (event.key === 'Tab') {
        const buttons = sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button')
        if (!buttons?.length)
          return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
        else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [sidebarOpen])

  const closeOnMobile = () => {
    if (window.innerWidth <= 760)
      setSidebarOpen(false)
  }
  const startNew = () => {
    setActiveId(null)
    setDraft('')
    setExtraInputs({})
    closeOnMobile()
    textareaRef.current?.focus()
  }
  const selectChat = (id: string) => {
    setActiveId(id)
    setDraft('')
    setExtraInputs({})
    closeOnMobile()
  }
  const patchMessage = (chatId: string, messageId: string, patch: Partial<ChatMessage>) => {
    setChats(previous => previous.map(chat => chat.id === chatId
      ? { ...chat, messages: chat.messages.map(message => message.id === messageId ? { ...message, ...patch } : message) }
      : chat))
  }

  const send = async (text = draft) => {
    if (!text.trim() || requestRef.current)
      return
    const chat = activeChat || newConversation()
    const now = Date.now()
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, status: 'complete', createdAt: now }
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', status: 'pending', createdAt: now }
    const controller = new AbortController()
    requestRef.current = controller
    setRunningChat(chat.id)
    setActiveId(chat.id)
    setDraft('')
    followScroll.current = true
    setChats(previous => {
      const updated = { ...chat, title: chat.messages.length ? chat.title : text.trim().replace(/\s+/g, ' ').slice(0, 36), updatedAt: now, messages: [...chat.messages, userMessage, assistantMessage] }
      return [updated, ...previous.filter(item => item.id !== chat.id)]
    })
    try {
      if (text.length > MAX_LENGTH)
        throw new Error('输入内容最多为 1024 个字符。')
      if (!inputVariable || configState !== 'ready')
        throw new Error('应用配置尚未就绪，请加载配置后重试。')
      const inputs: Record<string, string> = { ...extraInputs, [inputVariable.key]: text }
      for (const variable of otherVariables) {
        if (variable.required !== false && !inputs[variable.key]?.trim())
          throw new Error(`请填写「${variable.name}」后重新发送。`)
      }
      const response = await fetch(`${API_PREFIX}/${IS_WORKFLOW ? 'workflows/run' : 'completion-messages'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs, response_mode: 'streaming' }),
        signal: controller.signal,
      })
      const answer = await readChatStream(response, content => patchMessage(chat.id, assistantMessage.id, { content }), {
        signal: controller.signal,
        getWorkflowRun: IS_WORKFLOW
          ? async (runId, signal) => {
            const result = await fetch(`${API_PREFIX}/workflows/run/${encodeURIComponent(runId)}`, {
              credentials: 'include', cache: 'no-store', signal,
            })
            if (!result.ok)
              throw new Error('暂时无法查询工作流状态。')
            return result.json()
          }
          : undefined,
        onWaiting: waitingMessage => patchMessage(chat.id, assistantMessage.id, { waitingMessage }),
      })
      patchMessage(chat.id, assistantMessage.id, { content: answer, status: 'complete', waitingMessage: undefined })
    }
    catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'WorkflowStoppedError'))
        patchMessage(chat.id, assistantMessage.id, { status: 'stopped' })
      else
        patchMessage(chat.id, assistantMessage.id, { status: 'error', error: error instanceof Error ? error.message : '连接失败，请检查网络后重试。' })
    }
    finally {
      requestRef.current = null
      setRunningChat(null)
    }
  }

  const orderedChats = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
  const today = new Date().setHours(0, 0, 0, 0)
  const groups = [
    { label: '今天', items: orderedChats.filter(chat => chat.updatedAt >= today) },
    { label: '过去 7 天', items: orderedChats.filter(chat => chat.updatedAt < today && chat.updatedAt >= today - 6 * 86400000) },
    { label: '更早', items: orderedChats.filter(chat => chat.updatedAt < today - 6 * 86400000) },
  ]

  return (
    <div className={`wc-app ${sidebarOpen ? 'wc-sidebar-open' : ''}`} data-theme={theme}>
      <a className="wc-skip-link" href="#wc-composer">跳转到输入框</a>
      {sidebarOpen && <button type="button" className="wc-backdrop" tabIndex={-1} onClick={() => { setSidebarOpen(false); toggleRef.current?.focus() }} aria-label="关闭侧边栏" />}
      <aside id="wc-sidebar" className="wc-sidebar" ref={sidebarRef} aria-label="历史对话" aria-hidden={!sidebarOpen} {...(!sidebarOpen ? { inert: '' } : {})}>
        <div className="wc-sidebar-brand"><BrandMark small /><span>{APP_NAME}</span><button type="button" className="wc-icon-button" title="收起侧边栏" aria-label="收起侧边栏" onClick={() => { setSidebarOpen(false); toggleRef.current?.focus() }}><Bars3Icon /></button></div>
        <button type="button" className="wc-new-chat" onClick={startNew}><PencilSquareIcon /><span>开始新聊天</span><PlusIcon /></button>
        <div className="wc-history-heading">对话记录<span>{chats.length ? String(chats.length).padStart(2, '0') : ''}</span></div>
        <nav className="wc-history" aria-label="已保存的对话">
          {!chats.length && <div className="wc-history-empty"><DocumentTextIcon /><p>从一个想法开始</p><span>你的对话会保存在这里</span></div>}
          {groups.map(group => group.items.length > 0 && <div className="wc-history-group" key={group.label}><h2>{group.label}</h2>{group.items.map(chat => <div key={chat.id} className={`wc-history-row ${activeId === chat.id ? 'is-active' : ''}`}><button type="button" className="wc-history-select" onClick={() => selectChat(chat.id)} aria-current={activeId === chat.id ? 'page' : undefined} title={chat.title}><span className={runningChat === chat.id ? 'wc-history-dot is-running' : 'wc-history-dot'} /><span>{chat.title}</span></button><button type="button" className="wc-delete-chat wc-icon-button" disabled={runningChat === chat.id} aria-label={`删除对话：${chat.title}`} title="删除对话" onClick={() => { setChats(previous => previous.filter(item => item.id !== chat.id)); if (activeId === chat.id) startNew() }}><TrashIcon /></button></div>)}</div>)}
        </nav>
        <div className="wc-sidebar-footer"><span className="wc-local-icon"><CheckIcon /></span><div><strong>你的阅读空间</strong><p>对话记录仅保存在此浏览器</p></div></div>
      </aside>

      <main className="wc-main">
        <header className="wc-header"><div className="wc-header-left"><button ref={toggleRef} type="button" className="wc-icon-button" aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'} title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'} aria-expanded={sidebarOpen} aria-controls="wc-sidebar" onClick={() => setSidebarOpen(value => !value)}><Bars3Icon /></button><span className="wc-header-title">{APP_NAME}</span><span className="wc-header-divider" /><span className="wc-header-caption">让信息为你所用</span></div><div className="wc-header-right"><span className="wc-private-label"><span />个人空间</span><button type="button" className="wc-theme-button" aria-label={theme === 'light' ? '切换到黑夜主题' : '切换到白天主题'} title={theme === 'light' ? '切换到黑夜主题' : '切换到白天主题'} onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <MoonIcon /> : <SunIcon />}<span>{theme === 'light' ? '黑夜' : '白天'}</span></button></div></header>

        {(storageError || configState === 'error') && <div className="wc-banner" role="alert"><span>{configState === 'error' ? configError : storageError}</span>{configState === 'error' ? <button type="button" onClick={() => void loadConfig()}><ArrowPathIcon />重新连接</button> : <button type="button" className="wc-icon-button" aria-label="关闭提示" onClick={() => setStorageError('')}><XMarkIcon /></button>}</div>}

        <div className={`wc-stage ${hasMessages ? 'has-messages' : 'is-welcome'}`}>
          <div className="wc-thread-scroll" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (!element) return; const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100; followScroll.current = nearBottom; setShowScrollButton(!nearBottom) }}>
            {hasMessages
              ? <div className="wc-thread" aria-label="对话内容">{messages.map((message, index) => <Message key={message.id} message={message} onRetry={() => { const previousUser = messages.slice(0, index).reverse().find(item => item.role === 'user'); if (previousUser) void send(previousUser.content) }} />)}</div>
              : <section className="wc-welcome"><div className="wc-welcome-eyebrow"></div><div className="wc-hero-mark"><BrandMark /><span className="wc-hero-spark"><SparklesIcon /></span></div><h1>把复杂内容，<br className="wc-mobile-break" />变得清晰。</h1></section>}
          </div>

          <div className="wc-composer-zone">
            {hasMessages && showScrollButton && <button type="button" className="wc-scroll-bottom wc-icon-button" title="回到最新消息" aria-label="回到最新消息" onClick={() => { followScroll.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }}><ArrowDownIcon /></button>}
            <form className="wc-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
              {otherVariables.length > 0 && <details className="wc-extra-inputs"><summary>输入选项<ChevronDownIcon /></summary><div>{otherVariables.map(variable => <label key={variable.key}>{variable.name}{variable.required !== false && <span> *</span>}{variable.type === 'select' ? <select value={extraInputs[variable.key] || ''} onChange={event => setExtraInputs(previous => ({ ...previous, [variable.key]: event.target.value }))}><option value="">请选择</option>{variable.options?.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input type={variable.type === 'number' ? 'number' : 'text'} maxLength={variable.max_length} value={extraInputs[variable.key] || ''} onChange={event => setExtraInputs(previous => ({ ...previous, [variable.key]: event.target.value }))} />}</label>)}</div></details>}
              <label className="wc-visually-hidden" htmlFor="wc-composer">输入内容，最多 1024 个字符</label>
              <textarea id="wc-composer" ref={textareaRef} rows={2} value={draft} maxLength={MAX_LENGTH} placeholder={hasMessages ? '继续输入内容，探索更多…' : '粘贴网页链接，或输入你想梳理的内容…'} onChange={event => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (configState === 'ready') void send() } }} />
              <div className="wc-composer-toolbar"><div className="wc-composer-mode"><GlobeAltIcon /><span>网页与内容总结</span><span className="wc-mode-dot">·</span><span className="wc-character-count">{draft.length} / {MAX_LENGTH}</span></div>{runningChat ? <button type="button" className="wc-send-button" aria-label="停止生成" title="停止生成" onClick={() => requestRef.current?.abort()}><StopIcon /></button> : <button type="submit" className="wc-send-button" disabled={!draft.trim() || configState !== 'ready' || !ready} aria-label="发送消息" title="发送消息"><ArrowUpIcon /></button>}</div>
            </form>
            {!hasMessages && <div className="wc-suggestions">{suggestions.map(suggestion => <button type="button" key={suggestion.title} onClick={() => { setDraft(suggestion.prompt); textareaRef.current?.focus() }}><suggestion.icon /><strong>{suggestion.title}</strong><span>{suggestion.detail}</span><ArrowRightIcon className="wc-suggestion-arrow" /></button>)}</div>}
            <p className="wc-composer-footnote">{configState === 'loading' ? '正在连接你的阅读空间…' : <><span className="wc-keyboard-hint">Enter 发送 · Shift + Enter 换行<span> · </span></span>内容由 AI 生成，请核实重要信息</>}</p>
          </div>
        </div>
        {!hasMessages && <div className="wc-page-footer"><span>少一点信息噪音，多一点清晰思考。</span><span>WEB CONCLUSION</span></div>}
      </main>
    </div>
  )
}
