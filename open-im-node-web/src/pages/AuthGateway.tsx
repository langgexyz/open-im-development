import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { exchangeToken } from '../api/node'
import { useSession } from '../hooks/useSession'

export default function AuthGateway() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { hasSession, setSession } = useSession()

  useEffect(() => {
    if (hasSession) {
      navigate('/articles', { replace: true })
      return
    }
    const appToken = searchParams.get('token')
    if (!appToken) {
      navigate('/error', { replace: true })
      return
    }
    exchangeToken(appToken)
      .then(({ openim_token, openim_api_addr, group_id }) => {
        setSession(openim_token, openim_api_addr, group_id)
        // 清除 URL 中的 token 参数
        window.history.replaceState({}, '', '/')
        navigate('/articles', { replace: true })
      })
      .catch(() => navigate('/error', { replace: true }))
  }, [])

  return null
}
