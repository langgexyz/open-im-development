import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getNode, setNodeProfile } from '../../api/hub'
import { useAuth } from '../../hooks/useAuth'
import { Header } from '../../components/Header'

export default function NodeAdminPage() {
  const { app_id } = useParams<{ app_id: string }>()
  const { hubToken, uid, email, logout } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', avatar: '', description: '' })
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')

  // admin_uid 检查：加载节点信息后验证当前用户是否为该节点管理员
  useEffect(() => {
    if (!hubToken || !app_id) return
    getNode(hubToken, app_id).then(node => {
      if (node.admin_uid && uid !== node.admin_uid) navigate('/nodes', { replace: true })
    }).catch(() => navigate('/nodes', { replace: true }))
  }, [hubToken, app_id, uid, navigate])

  function set(key: string) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [key]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!app_id || !hubToken) return
    setStatus('loading')
    try {
      await setNodeProfile(hubToken, { app_id, ...form })
      setStatus('ok')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div style={{ background:'#f8f9fa', minHeight:'100vh' }}>
      <Header email={email} onLogout={logout} />
      <div style={{ maxWidth:480, margin:'48px auto', padding:'0 16px' }}>
        <h2>公众号资料</h2>
        <form onSubmit={handleSubmit}>
          <div><label htmlFor="name">公众号名称</label><br />
            <input id="name" value={form.name} onChange={set('name')} required /></div>
          <div style={{ marginTop:12 }}><label htmlFor="avatar">头像 URL</label><br />
            <input id="avatar" value={form.avatar} onChange={set('avatar')} placeholder="https://..." /></div>
          <div style={{ marginTop:12 }}><label htmlFor="desc">简介</label><br />
            <textarea id="desc" value={form.description} onChange={set('description')} rows={3} /></div>
          {status === 'ok' && <p style={{ color:'green' }}>保存成功！</p>}
          {status === 'error' && <p role="alert" style={{ color:'red' }}>保存失败，请重试</p>}
          <button type="submit" disabled={status === 'loading'} style={{ marginTop:16 }}>
            {status === 'loading' ? '保存中…' : '保存'}
          </button>
        </form>
      </div>
    </div>
  )
}
