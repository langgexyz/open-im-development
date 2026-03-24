import { describe, test, expect, vi, beforeEach } from 'vitest'
import { register, login, getCredential, getNodes, getNode, activateNode, setNodeProfile } from './hub'

const MOCK_URL = 'http://hub.test'
vi.stubEnv('VITE_HUB_API', MOCK_URL)

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  })
}

beforeEach(() => mockFetch.mockReset())

test('register 发送 POST /user/register 并返回 uid + hub_token', async () => {
  mockResponse({ uid: 'u1', hub_token: 'tok' })
  const res = await register('a@b.com', 'pass123')
  expect(mockFetch).toHaveBeenCalledWith(`${MOCK_URL}/user/register`, expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ email: 'a@b.com', password: 'pass123' }),
  }))
  expect(res).toEqual({ uid: 'u1', hub_token: 'tok' })
})

test('login 发送 POST /user/login', async () => {
  mockResponse({ uid: 'u2', hub_token: 'tok2' })
  const res = await login('a@b.com', 'pass123')
  expect(res).toEqual({ uid: 'u2', hub_token: 'tok2' })
})

test('getCredential 携带 Authorization header', async () => {
  mockResponse({ credential: 'cred.sig' })
  const res = await getCredential('tok', 'app-id-1')
  expect(mockFetch).toHaveBeenCalledWith(`${MOCK_URL}/user/credential`, expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
  }))
  expect(res.credential).toBe('cred.sig')
})

test('getNodes 返回节点列表', async () => {
  mockResponse([{ app_id: 'a1', name: 'Test' }])
  const res = await getNodes('tok')
  expect(res).toHaveLength(1)
})

test('getNode 返回单个节点', async () => {
  mockResponse({ app_id: 'a1', name: 'Test', avatar: '', description: '', node_server_addr: '', node_web_addr: '' })
  const res = await getNode('tok', 'a1')
  expect(res.app_id).toBe('a1')
})

test('activateNode 发送 POST /node/activate', async () => {
  mockResponse({ app_id: 'new-app' })
  await activateNode('tok', { node_server_addr: 'http://n:8080', node_web_addr: 'http://n', code: 'abc' })
  expect(mockFetch).toHaveBeenCalledWith(`${MOCK_URL}/node/activate`, expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ node_server_addr: 'http://n:8080', node_web_addr: 'http://n', code: 'abc' }),
  }))
})

test('setNodeProfile 发送 POST /node/profile', async () => {
  mockResponse({})
  await setNodeProfile('tok', { app_id: 'a1', name: '快讯', avatar: '', description: '简介' })
  expect(mockFetch).toHaveBeenCalledWith(`${MOCK_URL}/node/profile`, expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ app_id: 'a1', name: '快讯', avatar: '', description: '简介' }),
  }))
})

test('非 200 响应抛出错误', async () => {
  mockResponse({ error: 'Unauthorized' }, 401)
  await expect(login('x@y.com', 'wrong')).rejects.toThrow()
})
