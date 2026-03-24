import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import ArticleDetailPage from './ArticleDetailPage'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  sessionStorage.setItem('openim_token', 'tok')
  sessionStorage.setItem('openim_api_addr', 'http://api.test')
  sessionStorage.setItem('group_id', '0')
  mockFetch.mockReset()
})

test('content_url 返回 HTML 时渲染消毒后的内容', async () => {
  mockFetch.mockResolvedValue({
    ok: true, status: 200, text: () => Promise.resolve('<!DOCTYPE html><p>内容</p>'),
    headers: new Headers({ 'content-type': 'text/html' }),
  })
  render(
    <MemoryRouter initialEntries={['/articles/msg-1?url=http://content.test/a.html&title=标题']}>
      <Routes><Route path="/articles/:msg_id" element={<ArticleDetailPage />} /></Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(screen.getByText('内容')).toBeInTheDocument())
})

test('content_url 返回 Markdown 时用 react-markdown 渲染', async () => {
  mockFetch.mockResolvedValue({
    ok: true, status: 200, text: () => Promise.resolve('# Hello'),
    headers: new Headers({ 'content-type': 'text/markdown' }),
  })
  render(
    <MemoryRouter initialEntries={['/articles/msg-1?url=http://content.test/a.md&title=标题']}>
      <Routes><Route path="/articles/:msg_id" element={<ArticleDetailPage />} /></Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument())
})

test('content_url 非 200 时显示加载失败占位', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 404 })
  render(
    <MemoryRouter initialEntries={['/articles/msg-1?url=http://bad.url&title=标题']}>
      <Routes><Route path="/articles/:msg_id" element={<ArticleDetailPage />} /></Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(screen.getByText(/内容加载失败/)).toBeInTheDocument())
})
