import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AdminRoute } from './AdminRoute'

beforeEach(() => sessionStorage.clear())

test('nodes.admin_uid 与当前 uid 不匹配时跳转 /nodes', async () => {
  sessionStorage.setItem('uid', 'uid-A')
  // 模拟 Hub API 返回 admin_uid 不同的节点
  render(
    <MemoryRouter initialEntries={['/admin/nodes/app1']}>
      <Routes>
        <Route path="/nodes" element={<div>nodes page</div>} />
        <Route element={<AdminRoute adminUid="uid-B" />}>
          <Route path="/admin/nodes/:app_id" element={<div>admin page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
  expect(screen.getByText('nodes page')).toBeInTheDocument()
})

test('uid 匹配时渲染管理员页', () => {
  sessionStorage.setItem('uid', 'uid-A')
  render(
    <MemoryRouter initialEntries={['/admin/nodes/app1']}>
      <Routes>
        <Route path="/nodes" element={<div>nodes page</div>} />
        <Route element={<AdminRoute adminUid="uid-A" />}>
          <Route path="/admin/nodes/:app_id" element={<div>admin page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
  expect(screen.getByText('admin page')).toBeInTheDocument()
})
