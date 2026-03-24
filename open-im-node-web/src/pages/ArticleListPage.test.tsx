import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import ArticleListPage from './ArticleListPage'
import * as oimApi from '../api/openim'

vi.mock('../api/openim')

beforeEach(() => {
  sessionStorage.clear()
  sessionStorage.setItem('openim_token', 'tok')
  sessionStorage.setItem('openim_api_addr', 'http://api.test')
  sessionStorage.setItem('group_id', '0')
})

test('拉取并渲染文章列表', async () => {
  vi.mocked(oimApi.getMaxSeq).mockResolvedValue(5)
  vi.mocked(oimApi.pullMessages).mockResolvedValue([
    { seq:5, msg_id:'m1', send_time:1000000, content_type:'article',
      content: { title:'文章一', cover_url:'', summary:'', content_url:'' } }
  ])
  render(<MemoryRouter><ArticleListPage /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('文章一')).toBeInTheDocument())
})

test('max_seq 为 0 时显示空状态', async () => {
  vi.mocked(oimApi.getMaxSeq).mockResolvedValue(0)
  vi.mocked(oimApi.pullMessages).mockResolvedValue([])
  render(<MemoryRouter><ArticleListPage /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText(/暂无文章/)).toBeInTheDocument())
})

test('/articles 收到 401 时清除 session 并跳回 /', async () => {
  vi.mocked(oimApi.getMaxSeq).mockRejectedValue(Object.assign(new Error('401'), { status: 401 }))
  render(<MemoryRouter><ArticleListPage /></MemoryRouter>)
  await waitFor(() => expect(sessionStorage.getItem('openim_token')).toBeNull())
})
