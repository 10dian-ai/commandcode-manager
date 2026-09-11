interface AdminSession { authenticated: boolean; username: string | null }
export function useAuth() {
  const session = useState<AdminSession | null>('admin-session', () => null)
  const api = useRequestFetch()
  async function ensureSession(force = false) {
    if (!session.value || force) session.value = await api<AdminSession>('/api/auth/session')
    return session.value
  }
  return { session, ensureSession }
}
