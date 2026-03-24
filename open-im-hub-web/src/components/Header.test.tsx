import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Header } from './Header'

test('显示 Logo 文字', () => {
  render(<Header email={null} onLogout={() => {}} />)
  expect(screen.getByText('open-im')).toBeInTheDocument()
})

test('已登录时显示邮箱前缀', () => {
  render(<Header email="user@example.com" onLogout={() => {}} />)
  expect(screen.getByText(/user@/)).toBeInTheDocument()
})

test('点击退出调用 onLogout', async () => {
  const onLogout = vi.fn()
  const { getByRole } = render(<Header email="a@b.com" onLogout={onLogout} />)
  await userEvent.click(getByRole('button', { name: /退出/ }))
  expect(onLogout).toHaveBeenCalled()
})
