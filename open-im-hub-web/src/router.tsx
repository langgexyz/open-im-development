import { createBrowserRouter } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import NodesPage from './pages/NodesPage'
import NodeDetailPage from './pages/NodeDetailPage'
import ErrorPage from './pages/ErrorPage'
import ActivatePage from './pages/admin/ActivatePage'
import NodeAdminPage from './pages/admin/NodeAdminPage'
import { PrivateRoute } from './components/PrivateRoute'

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/error', element: <ErrorPage /> },
  {
    element: <PrivateRoute />,
    children: [
      { path: '/', element: <NodesPage /> },
      { path: '/nodes', element: <NodesPage /> },
      { path: '/nodes/:app_id', element: <NodeDetailPage /> },
      { path: '/admin/activate', element: <ActivatePage /> },
      // admin_uid 需异步加载节点数据才能得知，无法在路由层静态判断；
      // NodeAdminPage 内部 useEffect 加载节点后对比 admin_uid，不匹配则 navigate('/nodes')
      { path: '/admin/nodes/:app_id', element: <NodeAdminPage /> },
    ],
  },
])
