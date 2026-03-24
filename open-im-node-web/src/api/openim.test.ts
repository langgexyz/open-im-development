import { test, expect, vi, beforeEach } from 'vitest'
import { getMaxSeq, pullMessages, type OIMMessage } from './openim'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
beforeEach(() => mockFetch.mockReset())

function mockResponse(body: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(body) })
}

test('getMaxSeq 返回 conversation 的 max_seq', async () => {
  mockResponse({ data: { conversation_max_seqs: { group_0: 42 } } })
  const seq = await getMaxSeq('http://api.test', 'oim-tok', 'group_0')
  expect(mockFetch).toHaveBeenCalledWith(
    'http://api.test/msg/get_conversations_has_read_and_max_seq',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer oim-tok' }) })
  )
  expect(seq).toBe(42)
})

test('pullMessages 返回消息列表', async () => {
  const msgs: OIMMessage[] = [
    { seq: 1, msg_id: 'm1', send_time: 1000, content_type: 'article',
      content: { title: 'T1', cover_url: '', summary: '', content_url: 'http://url' } }
  ]
  mockResponse({ data: { msgs } })
  const result = await pullMessages('http://api.test', 'oim-tok', 'group_0', 1, 1)
  expect(result).toHaveLength(1)
  expect(result[0].msg_id).toBe('m1')
})

test('pullMessages 只返回 content_type=article 的消息', async () => {
  mockResponse({ data: { msgs: [
    { seq:1, msg_id:'m1', send_time:1000, content_type:'article', content:{ title:'T', cover_url:'', summary:'', content_url:'' } },
    { seq:2, msg_id:'m2', send_time:2000, content_type:'text', content:{ text:'hello' } },
  ]}})
  const result = await pullMessages('http://api.test', 'oim-tok', 'group_0', 1, 2)
  expect(result).toHaveLength(1)
  expect(result[0].msg_id).toBe('m1')
})
