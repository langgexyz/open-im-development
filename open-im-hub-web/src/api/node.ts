export async function getAppToken(nodeServerAddr: string, credential: string) {
  const res = await fetch(`${nodeServerAddr}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  })
  if (!res.ok) throw new Error(`/auth/token failed: ${res.status}`)
  return res.json() as Promise<{ app_token: string; app_uid: number }>
}
