export interface AppNode {
  app_id: string
  name: string
  avatar: string
  description: string
  node_server_addr: string
  node_web_addr: string
  admin_uid?: string   // Hub Server 返回，用于 NodeAdminPage 的管理员身份校验
}

const base = () => import.meta.env.VITE_HUB_API as string

async function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${base()}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

async function get(path: string, token?: string) {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${base()}${path}`, { headers })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

export const register = (email: string, password: string) =>
  post('/user/register', { email, password }) as Promise<{ uid: string; hub_token: string }>

export const login = (email: string, password: string) =>
  post('/user/login', { email, password }) as Promise<{ uid: string; hub_token: string }>

export const getCredential = (token: string, target_app_id: string) =>
  post('/user/credential', { target_app_id }, token) as Promise<{ credential: string }>

export const getNodes = (token: string) =>
  get('/nodes', token) as Promise<AppNode[]>

export const getNode = (token: string, app_id: string) =>
  get(`/nodes/${app_id}`, token) as Promise<AppNode>
// GET /nodes/:app_id — spec 6.5 定义了单节点结构，Hub Server 需同时支持此端点。
// 若 Hub Server 实现中仅有 GET /nodes（列表），可改为 getNodes(token).then(list => list.find(n => n.app_id === app_id)!)

export const activateNode = (token: string, body: {
  node_server_addr: string; node_web_addr: string; code: string
}) => post('/node/activate', body, token)

export const setNodeProfile = (token: string, body: {
  app_id: string; name: string; avatar: string; description: string
}) => post('/node/profile', body, token)
