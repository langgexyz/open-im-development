import { render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import AuthGateway from './AuthGateway'
import * as nodeApi from '../api/node'

vi.mock('../api/node')
const mockExchange = vi.mocked(nodeApi.exchangeToken)

beforeEach(() => {
  sessionStorage.clear()
  mockExchange.mockReset()
})

test('有有效 session 时直接跳转 /articles', async () => {
  sessionStorage.setItem('openim_token', 'tok')
  sessionStorage.setItem('openim_api_addr', 'http://api')
  sessionStorage.setItem('group_id', '0')
  const { container } = render(
    <MemoryRouter initialEntries={['/?token=app-tok']}>
      <Routes>
        <Route path="/" element={<AuthGateway />} />
        <Route path="/articles" element={<div>articles</div>} />
      </Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(container.textContent).toContain('articles'))
  expect(mockExchange).not.toHaveBeenCalled()
})

test('URL 有 app_token 时调用 exchange 并跳转 /articles', async () => {
  mockExchange.mockResolvedValue({ openim_token: 'new-tok', openim_api_addr: 'http://api', group_id: '0' })
  const { container } = render(
    <MemoryRouter initialEntries={['/?token=app-tok-123']}>
      <Routes>
        <Route path="/" element={<AuthGateway />} />
        <Route path="/articles" element={<div>articles</div>} />
        <Route path="/error" element={<div>error</div>} />
      </Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(container.textContent).toContain('articles'))
  expect(mockExchange).toHaveBeenCalledWith('app-tok-123')
  expect(sessionStorage.getItem('openim_token')).toBe('new-tok')
})

test('无 token 且无 session 时跳转 /error', async () => {
  const { container } = render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<AuthGateway />} />
        <Route path="/error" element={<div>error</div>} />
      </Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(container.textContent).toContain('error'))
})

test('exchange 失败时跳转 /error', async () => {
  mockExchange.mockRejectedValue(new Error('401'))
  const { container } = render(
    <MemoryRouter initialEntries={['/?token=bad-tok']}>
      <Routes>
        <Route path="/" element={<AuthGateway />} />
        <Route path="/error" element={<div>error</div>} />
      </Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(container.textContent).toContain('error'))
})
