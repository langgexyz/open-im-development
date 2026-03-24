import { test, expect, vi, beforeEach } from 'vitest'
import { getAppToken } from './node'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

test('getAppToken 向 node_server_addr/auth/token 发 POST', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ app_token: 'tok', app_uid: 42 }),
  })
  const res = await getAppToken('http://node.test:8080', 'cred.sig')
  expect(mockFetch).toHaveBeenCalledWith(
    'http://node.test:8080/auth/token',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ credential: 'cred.sig' }) })
  )
  expect(res).toEqual({ app_token: 'tok', app_uid: 42 })
})
