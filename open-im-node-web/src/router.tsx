import { createBrowserRouter } from 'react-router-dom'
import AuthGateway from './pages/AuthGateway'
import ArticleListPage from './pages/ArticleListPage'
import ArticleDetailPage from './pages/ArticleDetailPage'
import ErrorPage from './pages/ErrorPage'

export const router = createBrowserRouter([
  { path: '/', element: <AuthGateway /> },
  { path: '/articles', element: <ArticleListPage /> },
  { path: '/articles/:msg_id', element: <ArticleDetailPage /> },
  { path: '/error', element: <ErrorPage /> },
])
