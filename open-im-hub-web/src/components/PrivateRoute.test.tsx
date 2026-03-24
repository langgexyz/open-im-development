import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PrivateRoute } from './PrivateRoute'

beforeEach(() => sessionStorage.clear())

test('未登录时重定向到 /login', () => {
  render(
    <MemoryRouter initialEntries={['/nodes']}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route element={<PrivateRoute />}>
          <Route path="/nodes" element={<div>nodes</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
  expect(screen.getByText('login page')).toBeInTheDocument()
})

test('已登录时渲染子路由', () => {
  sessionStorage.setItem('uid', 'u1')
  sessionStorage.setItem('hub_token', 'tok')
  render(
    <MemoryRouter initialEntries={['/nodes']}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route element={<PrivateRoute />}>
          <Route path="/nodes" element={<div>nodes page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
  expect(screen.getByText('nodes page')).toBeInTheDocument()
})
