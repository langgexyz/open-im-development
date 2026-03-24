import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import ActivatePage from './ActivatePage'
import * as hubApi from '../../api/hub'

vi.mock('../../api/hub')
beforeEach(() => sessionStorage.setItem('hub_token', 'tok'))

test('填写表单并提交调用 activateNode', async () => {
  vi.mocked(hubApi.activateNode).mockResolvedValue({ app_id: 'new-app' })
  render(<MemoryRouter><ActivatePage /></MemoryRouter>)
  await userEvent.type(screen.getByLabelText(/节点服务地址/), 'http://n.test:8080')
  await userEvent.type(screen.getByLabelText(/Web 地址/), 'http://n.test')
  await userEvent.type(screen.getByLabelText(/激活码/), 'abc123')
  await userEvent.click(screen.getByRole('button', { name: /激活/ }))
  await waitFor(() => expect(hubApi.activateNode).toHaveBeenCalledWith('tok', {
    node_server_addr: 'http://n.test:8080',
    node_web_addr: 'http://n.test',
    code: 'abc123',
  }))
})

test('激活成功后显示成功提示', async () => {
  vi.mocked(hubApi.activateNode).mockResolvedValue({ app_id: 'new-app' })
  render(<MemoryRouter><ActivatePage /></MemoryRouter>)
  await userEvent.type(screen.getByLabelText(/节点服务地址/), 'http://n.test:8080')
  await userEvent.type(screen.getByLabelText(/Web 地址/), 'http://n.test')
  await userEvent.type(screen.getByLabelText(/激活码/), 'abc123')
  await userEvent.click(screen.getByRole('button', { name: /激活/ }))
  await waitFor(() => expect(screen.getByText(/激活成功/)).toBeInTheDocument())
})
