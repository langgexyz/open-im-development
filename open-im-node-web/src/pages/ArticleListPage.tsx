import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getMaxSeq, pullMessages, type OIMMessage } from '../api/openim'
import { useSession } from '../hooks/useSession'
import ArticleCard from '../components/ArticleCard'
import { NodeHeader } from '../components/NodeHeader'

const PAGE_SIZE = 20

export default function ArticleListPage() {
  const { openim_token, openim_api_addr, group_id, clearSession } = useSession()
  const navigate = useNavigate()
  const conversationId = `group_${group_id}`

  const [articles, setArticles] = useState<OIMMessage[]>([])
  const [minSeq, setMinSeq] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)

  const loadPage = useCallback(async (endSeq: number) => {
    if (!openim_token || !openim_api_addr || loading) return
    setLoading(true)
    try {
      const begin = Math.max(1, endSeq - PAGE_SIZE + 1)
      const msgs = await pullMessages(openim_api_addr, openim_token, conversationId, begin, endSeq)
      setArticles(prev => {
        const ids = new Set(prev.map(m => m.msg_id))
        return [...prev, ...msgs.filter(m => !ids.has(m.msg_id))]
          .sort((a, b) => b.seq - a.seq)
      })
      setMinSeq(begin)
      if (begin <= 1) setHasMore(false)
    } catch (e: unknown) {
      const err = e as { status?: number }
      if (err?.status === 401 || String(e).includes('401')) {
        clearSession()
        navigate('/', { replace: true })
      }
    } finally {
      setLoading(false)
    }
  }, [openim_token, openim_api_addr, conversationId, loading])

  useEffect(() => {
    if (!openim_token || !openim_api_addr) return
    getMaxSeq(openim_api_addr, openim_token, conversationId)
      .then(seq => { if (seq > 0) loadPage(seq) })
      .catch((e: unknown) => {
        const err = e as { status?: number }
        if (err?.status === 401 || String(e).includes('401')) {
          clearSession()
          navigate('/', { replace: true })
        }
      })
  }, [])

  return (
    <div style={{ maxWidth:680, margin:'0 auto', padding:'0 16px', background:'#fff', minHeight:'100vh' }}>
      <NodeHeader name="" avatar="" />
      {articles.length === 0 && !loading && (
        <p style={{ textAlign:'center', color:'#9ca3af', marginTop:48 }}>暂无文章</p>
      )}
      {articles.map(msg => <ArticleCard key={msg.msg_id} msg={msg} />)}
      {hasMore && articles.length > 0 && (
        <button onClick={() => minSeq && loadPage(minSeq - 1)}
          disabled={loading} style={{ width:'100%', padding:12, marginTop:8, border:'none',
            background:'none', color:'#6b7280', cursor:'pointer' }}>
          {loading ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  )
}
