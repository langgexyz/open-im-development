export default function ErrorPage() {
  return (
    <div style={{ maxWidth:680, margin:'120px auto', textAlign:'center', padding:'0 16px' }}>
      <h2 style={{ fontSize:18, marginBottom:8 }}>访问出错</h2>
      <p style={{ color:'#9ca3af', fontSize:14 }}>
        缺少有效凭证，请通过 Hub Web 订阅后访问。
      </p>
    </div>
  )
}
