import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getNode, getCredential, type AppNode } from '../api/hub'
import { getAppToken } from '../api/node'
import { useAuth } from '../hooks/useAuth'
import { Header } from '../components/Header'

export default function NodeDetailPage() {
  const { app_id } = useParams<{ app_id: string }>()
  const { hubToken, uid, email, logout } = useAuth()
  const [node, setNode] = useState<AppNode | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (hubToken && app_id) getNode(hubToken, app_id).then(setNode).catch(console.error)
  }, [hubToken, app_id])

  async function handleSubscribe() {
    if (!node || !hubToken || !uid) return
    setLoading(true); setError('')
    try {
      const { credential } = await getCredential(hubToken, node.app_id)
      const { app_token } = await getAppToken(node.node_server_addr, credential)
      window.location.assign(`${node.node_web_addr}/?token=${app_token}`)
    } catch {
      setError('订阅失败，请重试')
      setLoading(false)
    }
  }

  if (!node) return <div>加载中…</div>

  return (
    <div style={{ background:'#f8f9fa', minHeight:'100vh' }}>
      <Header email={email} onLogout={logout} />
      <div style={{ maxWidth:640, margin:'48px auto', padding:'0 16px' }}>
        <h2>{node.name}</h2>
        <p style={{ color:'#6b7280' }}>{node.description}</p>
        <p style={{ fontSize:12, color:'#9ca3af' }}>AppId: {node.app_id}</p>
        {error && <div role="alert" style={{ color:'red' }}>{error}</div>}
        <button onClick={handleSubscribe} disabled={loading} style={{ marginTop:16, padding:'10px 24px' }}>
          {loading ? '处理中…' : '订阅公众号'}
        </button>
      </div>
    </div>
  )
}
