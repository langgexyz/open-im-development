import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { login } from '../api/hub'
import { useAuth } from '../hooks/useAuth'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login: setAuth } = useAuth()
  const navigate = useNavigate()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const res = await login(email, password)
      setAuth(res.uid, res.hub_token, email)
      navigate('/nodes')
    } catch {
      setError('登录失败，请检查邮箱和密码')
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: '80px auto', padding: 24 }}>
      <h2>登录</h2>
      <form onSubmit={handleSubmit}>
        <div><label htmlFor="email">邮箱</label><br />
          <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
        <div style={{ marginTop: 12 }}><label htmlFor="password">密码</label><br />
          <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
        {error && <div role="alert" style={{ color: 'red', marginTop: 8 }}>{error}</div>}
        <button type="submit" style={{ marginTop: 16 }}>登录</button>
      </form>
      <p style={{ marginTop: 16, fontSize: 14 }}>没有账号？<Link to="/register">注册</Link></p>
    </div>
  )
}
