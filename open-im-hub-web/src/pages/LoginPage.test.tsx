import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { vi, test, expect, beforeEach } from 'vitest'
import LoginPage from './LoginPage'
import * as hubApi from '../api/hub'

vi.mock('../api/hub')
const mockLogin = vi.mocked(hubApi.login)

beforeEach(() => sessionStorage.clear())

test('提交表单调用 login API 并存储 sessionStorage', async () => {
  mockLogin.mockResolvedValue({ uid: 'u1', hub_token: 'tok' })
  render(<MemoryRouter><LoginPage /></MemoryRouter>)
  await userEvent.type(screen.getByLabelText(/邮箱/), 'a@b.com')
  await userEvent.type(screen.getByLabelText(/密码/), 'pass123')
  await userEvent.click(screen.getByRole('button', { name: /登录/ }))
  await waitFor(() => {
    expect(sessionStorage.getItem('hub_token')).toBe('tok')
  })
})

test('API 失败时显示错误信息', async () => {
  mockLogin.mockRejectedValue(new Error('Invalid credentials'))
  render(<MemoryRouter><LoginPage /></MemoryRouter>)
  await userEvent.type(screen.getByLabelText(/邮箱/), 'bad@b.com')
  await userEvent.type(screen.getByLabelText(/密码/), 'wrong')
  await userEvent.click(screen.getByRole('button', { name: /登录/ }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
})
