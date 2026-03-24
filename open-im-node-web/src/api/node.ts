export interface ExchangeResult {
  openim_token: string
  openim_api_addr: string
  group_id: string
}

export async function exchangeToken(app_token: string): Promise<ExchangeResult> {
  const res = await fetch('/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_token }),
  })
  if (!res.ok) throw new Error(`/auth/exchange failed: ${res.status}`)
  return res.json()
}
