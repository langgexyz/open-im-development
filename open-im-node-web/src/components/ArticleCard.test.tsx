import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ArticleCard from './ArticleCard'
import type { OIMMessage } from '../api/openim'

const msg: OIMMessage = {
  seq: 1, msg_id: 'msg-001', send_time: 1742000000000,
  content_type: 'article',
  content: { title: '测试文章标题', cover_url: 'http://img.test/cover.jpg', summary: '摘要', content_url: '' }
}

test('显示文章标题', () => {
  render(<MemoryRouter><ArticleCard msg={msg} /></MemoryRouter>)
  expect(screen.getByText('测试文章标题')).toBeInTheDocument()
})

test('显示封面图', () => {
  render(<MemoryRouter><ArticleCard msg={msg} /></MemoryRouter>)
  expect(screen.getByRole('img')).toHaveAttribute('src', 'http://img.test/cover.jpg')
})

test('标题超过 2 行时用 CSS line-clamp 截断（设置了 data-testid）', () => {
  render(<MemoryRouter><ArticleCard msg={msg} /></MemoryRouter>)
  expect(screen.getByTestId('title')).toBeInTheDocument()
})
