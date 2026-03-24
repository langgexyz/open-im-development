import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import NodeAdminPage from './NodeAdminPage'
import * as hubApi from '../../api/hub'

vi.mock('../../api/hub')

beforeEach(() => {
  sessionStorage.setItem('hub_token', 'tok')
  sessionStorage.setItem('uid', 'uid-admin')
  // 默认 getNode 返回当前用户是管理员的节点
  vi.mocked(hubApi.getNode).mockResolvedValue({
    app_id: 'app1', name: '快讯', avatar: '', description: '',
    node_server_addr: '', node_web_addr: '', admin_uid: 'uid-admin'
  })
})

test('非管理员访问时跳转 /nodes', async () => {
  vi.mocked(hubApi.getNode).mockResolvedValue({
    app_id: 'app1', name: '快讯', avatar: '', description: '',
    node_server_addr: '', node_web_addr: '', admin_uid: 'other-uid'
  })
  const { container } = render(<MemoryRouter initialEntries={['/admin/nodes/app1']}><Routes>
    <Route path="/nodes" element={<div>nodes page</div>} />
    <Route path="/admin/nodes/:app_id" element={<NodeAdminPage />} />
  </Routes></MemoryRouter>)
  await waitFor(() => expect(container.textContent).toContain('nodes page'))
})

test('提交资料调用 setNodeProfile', async () => {
  vi.mocked(hubApi.setNodeProfile).mockResolvedValue({})
  render(<MemoryRouter initialEntries={['/admin/nodes/app1']}><Routes>
    <Route path="/admin/nodes/:app_id" element={<NodeAdminPage />} />
  </Routes></MemoryRouter>)
  await userEvent.type(screen.getByLabelText(/公众号名称/), '科技快讯')
  await userEvent.type(screen.getByLabelText(/简介/), '最新科技资讯')
  await userEvent.click(screen.getByRole('button', { name: /保存/ }))
  await waitFor(() => expect(hubApi.setNodeProfile).toHaveBeenCalledWith('tok',
    expect.objectContaining({ app_id: 'app1', name: '科技快讯' })
  ))
})
