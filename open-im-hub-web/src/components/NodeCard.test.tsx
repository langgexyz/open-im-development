import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NodeCard from './NodeCard'

const node = { app_id: 'a1', name: '科技快讯', avatar: '', description: '这是一段很长的描述'.repeat(10), node_server_addr: '', node_web_addr: '' }

test('显示节点名称', () => {
  render(<MemoryRouter><NodeCard node={node} /></MemoryRouter>)
  expect(screen.getByText('科技快讯')).toBeInTheDocument()
})

test('描述超过 50 字时截断', () => {
  render(<MemoryRouter><NodeCard node={node} /></MemoryRouter>)
  const desc = screen.getByTestId('description').textContent!
  expect(desc.length).toBeLessThanOrEqual(53) // 50 + "..."
})
