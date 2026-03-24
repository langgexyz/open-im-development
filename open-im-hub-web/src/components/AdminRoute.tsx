import { Navigate, Outlet } from 'react-router-dom'

interface Props { adminUid: string | null }

export function AdminRoute({ adminUid }: Props) {
  const uid = sessionStorage.getItem('uid')
  return uid && adminUid && uid === adminUid ? <Outlet /> : <Navigate to="/nodes" replace />
}
