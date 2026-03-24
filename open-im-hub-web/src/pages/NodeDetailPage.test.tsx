import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import NodeDetailPage from './NodeDetailPage'
import * as hubApi from '../api/hub'
import * as nodeApi from '../api/node'

vi.mock('../api/hub')
vi.mock('../api/node')

const mockNode = {
  app_id: 'app1', name: '科技快讯', avatar: '', description: '描述',
  node_server_addr: 'http://node.test:8080', node_web_addr: 'http://node.test'
}

beforeEach(() => {
  sessionStorage.setItem('hub_token', 'tok')
  sessionStorage.setItem('uid', 'uid1')
  vi.mocked(hubApi.getNode).mockResolvedValue(mockNode)
})

test('显示节点信息', async () => {
  render(<MemoryRouter initialEntries={['/nodes/app1']}><Routes>
    <Route path="/nodes/:app_id" element={<NodeDetailPage />} />
  </Routes></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('科技快讯')).toBeInTheDocument())
})

test('点击订阅触发 credential + app_token 流程并跳转', async () => {
  vi.mocked(hubApi.getCredential).mockResolvedValue({ credential: 'cred.sig' })
  vi.mocked(nodeApi.getAppToken).mockResolvedValue({ app_token: 'appTok', app_uid: 1 })
  const assignMock = vi.fn()
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign: assignMock },
    writable: true,
    configurable: true,
  })
  render(<MemoryRouter initialEntries={['/nodes/app1']}><Routes>
    <Route path="/nodes/:app_id" element={<NodeDetailPage />} />
  </Routes></MemoryRouter>)
  await waitFor(() => screen.getByText('科技快讯'))
  await userEvent.click(screen.getByRole('button', { name: /订阅公众号/ }))
  await waitFor(() => expect(assignMock).toHaveBeenCalledWith('http://node.test/?token=appTok'))
})
