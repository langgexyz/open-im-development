import { Link } from 'react-router-dom'
import type { OIMMessage } from '../api/openim'

export default function ArticleCard({ msg }: { msg: OIMMessage }) {
  const { title, cover_url } = msg.content
  const date = new Date(msg.send_time).toLocaleDateString('zh-CN')
  return (
    <Link to={`/articles/${msg.msg_id}?url=${encodeURIComponent(msg.content.content_url)}&title=${encodeURIComponent(msg.content.title)}`} style={{ textDecoration:'none', color:'inherit' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
        padding:'12px 0', borderBottom:'1px solid #f0f0f0' }}>
        <div style={{ flex:1, marginRight:12 }}>
          <p data-testid="title" style={{
            margin:'0 0 4px', fontSize:15, fontWeight:500,
            display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden'
          }}>{title}</p>
          <span style={{ fontSize:12, color:'#9ca3af' }}>{date}</span>
        </div>
        {cover_url && (
          <img src={cover_url} alt={title} width={56} height={42}
            style={{ objectFit:'cover', borderRadius:4, flexShrink:0 }} />
        )}
      </div>
    </Link>
  )
}
