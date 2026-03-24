interface Props { name: string; avatar: string }

export function NodeHeader({ name, avatar }: Props) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'16px 0 12px',
      borderBottom:'1px solid #f0f0f0', marginBottom:8 }}>
      {avatar && <img src={avatar} alt="" width={36} height={36} style={{ borderRadius:18 }} />}
      <span style={{ fontSize:16, fontWeight:600 }}>{name}</span>
    </div>
  )
}
