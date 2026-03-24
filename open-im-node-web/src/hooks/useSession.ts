import { useState } from 'react'

const KEYS = { token: 'openim_token', addr: 'openim_api_addr', gid: 'group_id' }

export function useSession() {
  const [token, setToken] = useState(() => sessionStorage.getItem(KEYS.token))
  const [addr, setAddr] = useState(() => sessionStorage.getItem(KEYS.addr))
  const [gid, setGid] = useState(() => sessionStorage.getItem(KEYS.gid))

  function setSession(openim_token: string, openim_api_addr: string, group_id: string) {
    sessionStorage.setItem(KEYS.token, openim_token)
    sessionStorage.setItem(KEYS.addr, openim_api_addr)
    sessionStorage.setItem(KEYS.gid, group_id)
    setToken(openim_token); setAddr(openim_api_addr); setGid(group_id)
  }

  function clearSession() {
    Object.values(KEYS).forEach(k => sessionStorage.removeItem(k))
    setToken(null); setAddr(null); setGid(null)
  }

  return {
    openim_token: token,
    openim_api_addr: addr,
    group_id: gid,
    hasSession: !!token && !!addr && !!gid,
    setSession,
    clearSession,
  }
}
