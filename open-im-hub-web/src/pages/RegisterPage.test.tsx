import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { vi, test, expect, beforeEach } from 'vitest'
import RegisterPage from './RegisterPage'
import * as hubApi from '../api/hub'

vi.mock('../api/hub')
const mockRegister = vi.mocked(hubApi.register)

beforeEach(() => sessionStorage.clear())

test('提交表单调用 register API 并存储 sessionStorage', async () => {
  mockRegister.mockResolvedValue({ uid: 'u2', hub_token: 'tok2' })
  render(<MemoryRouter><RegisterPage /></MemoryRouter>)
  await userEvent.type(screen.getByLabelText(/邮箱/), 'new@b.com')
  await userEvent.type(screen.getByLabelText(/密码/), 'pass456')
  await userEvent.click(screen.getByRole('button', { name: /注册/ }))
  await waitFor(() => {
    expect(sessionStorage.getItem('hub_token')).toBe('tok2')
  })
})

test('API 失败时显示错误信息', async () => {
  mockRegister.mockRejectedValue(new Error('Email already exists'))
  render(<MemoryRouter><RegisterPage /></MemoryRouter>)
  await userEvent.type(screen.getByLabelText(/邮箱/), 'dup@b.com')
  await userEvent.type(screen.getByLabelText(/密码/), 'pass456')
  await userEvent.click(screen.getByRole('button', { name: /注册/ }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
})
