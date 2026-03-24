import { useState } from 'react'

const KEYS = { uid: 'uid', token: 'hub_token', email: 'email' }

export function useAuth() {
  const [uid, setUid] = useState<string | null>(() => sessionStorage.getItem(KEYS.uid))
  const [hubToken, setHubToken] = useState<string | null>(() => sessionStorage.getItem(KEYS.token))
  const [email, setEmail] = useState<string | null>(() => sessionStorage.getItem(KEYS.email))

  function login(uid: string, token: string, email: string) {
    sessionStorage.setItem(KEYS.uid, uid)
    sessionStorage.setItem(KEYS.token, token)
    sessionStorage.setItem(KEYS.email, email)
    setUid(uid); setHubToken(token); setEmail(email)
  }

  function logout() {
    Object.values(KEYS).forEach(k => sessionStorage.removeItem(k))
    setUid(null); setHubToken(null); setEmail(null)
  }

  return { uid, hubToken, email, isLoggedIn: !!uid && !!hubToken, login, logout }
}
