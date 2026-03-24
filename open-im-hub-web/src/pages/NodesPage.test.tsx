import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import NodesPage from './NodesPage'
import * as hubApi from '../api/hub'

vi.mock('../api/hub')
beforeEach(() => sessionStorage.setItem('hub_token', 'tok'))

test('加载节点列表并渲染卡片', async () => {
  vi.mocked(hubApi.getNodes).mockResolvedValue([
    { app_id:'a1', name:'快讯', avatar:'', description:'desc', node_server_addr:'', node_web_addr:'' }
  ])
  render(<MemoryRouter><NodesPage /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('快讯')).toBeInTheDocument())
})
