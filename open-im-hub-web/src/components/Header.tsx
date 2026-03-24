interface Props { email: string | null; onLogout: () => void }

export function Header({ email, onLogout }: Props) {
  return (
    <header style={{ display:'flex', justifyContent:'space-between', padding:'12px 24px',
      background:'#fff', borderBottom:'1px solid #e5e7eb' }}>
      <span style={{ fontWeight: 700, fontSize: 18 }}>open-im</span>
      {email && (
        <div style={{ display:'flex', gap:12, alignItems:'center' }}>
          <span style={{ fontSize:14, color:'#6b7280' }}>{email.slice(0, 12)}{email.length > 12 ? '…' : ''}</span>
          <button onClick={onLogout} style={{ fontSize:13, cursor:'pointer' }}>退出</button>
        </div>
      )}
    </header>
  )
}
