export interface ArticleContent {
  title: string
  cover_url: string
  summary: string
  content_url: string
}

export interface OIMMessage {
  seq: number
  msg_id: string
  send_time: number
  content_type: string
  content: ArticleContent
}

async function postOIM(apiAddr: string, token: string, path: string, body: unknown) {
  const res = await fetch(`${apiAddr}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`OpenIM ${path} failed: ${res.status}`)
  return res.json()
}

export async function getMaxSeq(apiAddr: string, token: string, conversationId: string): Promise<number> {
  const res = await postOIM(apiAddr, token, '/msg/get_conversations_has_read_and_max_seq', {
    conversation_ids: [conversationId],
  })
  return res.data.conversation_max_seqs[conversationId] ?? 0
}

export async function pullMessages(
  apiAddr: string, token: string, conversationId: string,
  begin: number, end: number
): Promise<OIMMessage[]> {
  const res = await postOIM(apiAddr, token, '/msg/pull_msg_by_seq', {
    conversation_id: conversationId,
    seq_ranges: [{ begin, end }],
  })
  const msgs: OIMMessage[] = res.data?.msgs ?? []
  return msgs.filter(m => m.content_type === 'article')
}
