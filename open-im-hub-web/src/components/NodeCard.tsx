import { Link } from 'react-router-dom'
import type { AppNode } from '../api/hub'

export default function NodeCard({ node }: { node: AppNode }) {
  const desc = node.description.length > 50
    ? node.description.slice(0, 50) + '...'
    : node.description
  return (
    <Link to={`/nodes/${node.app_id}`} style={{ textDecoration:'none' }}>
      <div style={{ background:'#fff', borderRadius:12, padding:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)', cursor:'pointer' }}>
        {node.avatar && <img src={node.avatar} alt="" width={40} height={40} style={{ borderRadius:20 }} />}
        <h3 style={{ margin:'8px 0 4px', fontSize:16 }}>{node.name}</h3>
        <p data-testid="description" style={{ fontSize:13, color:'#6b7280', margin:0 }}>{desc}</p>
      </div>
    </Link>
  )
}
