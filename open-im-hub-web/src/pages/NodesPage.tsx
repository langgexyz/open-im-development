import { useEffect, useState } from 'react'
import { getNodes, type AppNode } from '../api/hub'
import { useAuth } from '../hooks/useAuth'
import { Header } from '../components/Header'
import NodeCard from '../components/NodeCard'

export default function NodesPage() {
  const { hubToken, email, logout } = useAuth()
  const [nodes, setNodes] = useState<AppNode[]>([])

  useEffect(() => {
    if (hubToken) getNodes(hubToken).then(setNodes).catch(console.error)
  }, [hubToken])

  return (
    <div style={{ background:'#f8f9fa', minHeight:'100vh' }}>
      <Header email={email} onLogout={logout} />
      <div style={{ maxWidth:900, margin:'0 auto', padding:'32px 16px' }}>
        <h2 style={{ marginBottom:24 }}>节点广场</h2>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:16 }}>
          {nodes.map(n => <NodeCard key={n.app_id} node={n} />)}
        </div>
      </div>
    </div>
  )
}
