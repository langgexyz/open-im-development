import { useState } from 'react'
import { activateNode } from '../../api/hub'
import { useAuth } from '../../hooks/useAuth'
import { Header } from '../../components/Header'

export default function ActivatePage() {
  const { hubToken, email, logout } = useAuth()
  const [form, setForm] = useState({ node_server_addr: '', node_web_addr: '', code: '' })
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')

  function set(key: string) {
    return (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [key]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('loading')
    try {
      await activateNode(hubToken!, form)
      setStatus('ok')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div style={{ background:'#f8f9fa', minHeight:'100vh' }}>
      <Header email={email} onLogout={logout} />
      <div style={{ maxWidth:480, margin:'48px auto', padding:'0 16px' }}>
        <h2>节点激活</h2>
        <form onSubmit={handleSubmit}>
          <div><label htmlFor="nsa">节点服务地址</label><br />
            <input id="nsa" value={form.node_server_addr} onChange={set('node_server_addr')} placeholder="http://node.example.com:8080" required /></div>
          <div style={{ marginTop:12 }}><label htmlFor="nwa">Web 地址</label><br />
            <input id="nwa" value={form.node_web_addr} onChange={set('node_web_addr')} placeholder="https://node.example.com" required /></div>
          <div style={{ marginTop:12 }}><label htmlFor="code">激活码</label><br />
            <input id="code" value={form.code} onChange={set('code')} placeholder="64 字符 hex" required /></div>
          {status === 'ok' && <p style={{ color:'green' }}>激活成功！</p>}
          {status === 'error' && <p role="alert" style={{ color:'red' }}>激活失败，请检查输入</p>}
          <button type="submit" disabled={status === 'loading'} style={{ marginTop:16 }}>
            {status === 'loading' ? '激活中…' : '激活'}
          </button>
        </form>
      </div>
    </div>
  )
}
