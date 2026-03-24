import { Navigate, Outlet } from 'react-router-dom'

export function PrivateRoute() {
  const uid = sessionStorage.getItem('uid')
  const token = sessionStorage.getItem('hub_token')
  return uid && token ? <Outlet /> : <Navigate to="/login" replace />
}
