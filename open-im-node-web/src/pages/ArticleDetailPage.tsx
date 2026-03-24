import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import DOMPurify from 'dompurify'
import ReactMarkdown from 'react-markdown'

type ContentState =
  | { type: 'loading' }
  | { type: 'html'; html: string }
  | { type: 'markdown'; text: string }
  | { type: 'error' }

export default function ArticleDetailPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const contentUrl = searchParams.get('url') ?? ''
  const title = searchParams.get('title') ?? ''
  const [content, setContent] = useState<ContentState>({ type: 'loading' })

  useEffect(() => {
    if (!contentUrl) { setContent({ type: 'error' }); return }
    fetch(contentUrl)
      .then(async res => {
        if (!res.ok) { setContent({ type: 'error' }); return }
        const text = await res.text()
        const ct = res.headers.get('content-type') ?? ''
        if (text.includes('<!DOCTYPE') || text.includes('<html') || ct.includes('html')) {
          setContent({ type: 'html', html: DOMPurify.sanitize(text) })
        } else {
          setContent({ type: 'markdown', text })
        }
      })
      .catch(() => setContent({ type: 'error' }))
  }, [contentUrl])

  return (
    <div style={{ maxWidth:680, margin:'0 auto', padding:'16px 16px 48px', background:'#fff', minHeight:'100vh' }}>
      <button onClick={() => navigate(-1)}
        style={{ background:'none', border:'none', cursor:'pointer', color:'#6b7280', marginBottom:16 }}>
        ← 返回
      </button>
      <h1 style={{ fontSize:20, fontWeight:700, marginBottom:16 }}>{title}</h1>
      {content.type === 'loading' && <p style={{ color:'#9ca3af' }}>加载中…</p>}
      {content.type === 'error' && <p style={{ color:'#9ca3af' }}>内容加载失败</p>}
      {content.type === 'html' && (
        <div dangerouslySetInnerHTML={{ __html: content.html }} />
      )}
      {content.type === 'markdown' && <ReactMarkdown>{content.text}</ReactMarkdown>}
    </div>
  )
}
