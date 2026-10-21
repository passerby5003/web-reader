export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'pending' | 'complete' | 'error' | 'stopped'
  error?: string
  createdAt: number
}

export type Conversation = {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
}

export const newConversation = (): Conversation => ({
  id: crypto.randomUUID(),
  title: '新对话',
  updatedAt: Date.now(),
  messages: [],
})

export function restoreConversations(raw: string | null): Conversation[] {
  if (!raw)
    return []
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data))
    throw new Error('Invalid conversation history')
  return data.filter((chat): chat is Conversation => (
    chat && typeof chat.id === 'string' && typeof chat.title === 'string'
    && typeof chat.updatedAt === 'number' && Array.isArray(chat.messages)
    && chat.messages.every((message: ChatMessage) => (
      message && typeof message.id === 'string' && typeof message.content === 'string'
      && ['user', 'assistant'].includes(message.role)
      && ['pending', 'complete', 'error', 'stopped'].includes(message.status)
      && typeof message.createdAt === 'number'
    ))
  )).map(chat => ({
    ...chat,
    messages: chat.messages.map(message => message.status === 'pending'
      ? { ...message, status: 'error', error: '上次生成已中断，可以重新发送。' }
      : message),
  }))
}
