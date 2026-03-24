// AdminRoute is not wired directly into the router because admin_uid requires
// an async API call to determine — it cannot be known at route render time.
// Instead, NodeAdminPage performs the check internally via useEffect.
// This component is tested independently and may be used where adminUid
// is statically known (e.g., conditionally rendering management entry links).
import { Navigate, Outlet } from 'react-router-dom'

interface Props { adminUid: string | null }

export function AdminRoute({ adminUid }: Props) {
  const uid = sessionStorage.getItem('uid')
  return uid && adminUid && uid === adminUid ? <Outlet /> : <Navigate to="/nodes" replace />
}
