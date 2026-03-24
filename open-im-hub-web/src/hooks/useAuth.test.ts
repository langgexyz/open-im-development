import { renderHook, act } from '@testing-library/react'
import { useAuth } from './useAuth'

beforeEach(() => sessionStorage.clear())

test('初始状态为未登录', () => {
  const { result } = renderHook(() => useAuth())
  expect(result.current.uid).toBeNull()
  expect(result.current.hubToken).toBeNull()
  expect(result.current.email).toBeNull()
  expect(result.current.isLoggedIn).toBe(false)
})

test('login 存储凭证并更新状态', () => {
  const { result } = renderHook(() => useAuth())
  act(() => result.current.login('uid-123', 'tok-abc', 'a@b.com'))
  expect(result.current.uid).toBe('uid-123')
  expect(result.current.hubToken).toBe('tok-abc')
  expect(result.current.email).toBe('a@b.com')
  expect(result.current.isLoggedIn).toBe(true)
})

test('logout 清除凭证', () => {
  const { result } = renderHook(() => useAuth())
  act(() => result.current.login('uid-123', 'tok-abc', 'a@b.com'))
  act(() => result.current.logout())
  expect(result.current.isLoggedIn).toBe(false)
})

test('刷新后从 sessionStorage 恢复', () => {
  sessionStorage.setItem('uid', 'uid-999')
  sessionStorage.setItem('hub_token', 'tok-xyz')
  sessionStorage.setItem('email', 'x@y.com')
  const { result } = renderHook(() => useAuth())
  expect(result.current.uid).toBe('uid-999')
  expect(result.current.isLoggedIn).toBe(true)
})
