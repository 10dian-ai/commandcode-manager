export function apiErrorMessage(error: unknown): string {
  const value = error as { data?: { statusMessage?: string; message?: string }; statusMessage?: string; message?: string }
  return value?.data?.statusMessage || value?.data?.message || value?.statusMessage || value?.message || '操作失败，请稍后重试'
}
export function useApiAction() {
  const busy = ref(false)
  const toast = useToast()
  const route = useRoute()
  const { session } = useAuth()
  async function run<T>(action: () => Promise<T>, message?: string): Promise<{ ok: true; value: T } | { ok: false }> {
    if (busy.value) return { ok: false }
    busy.value = true
    try {
      const value = await action()
      if (message) toast.add({ title: message, color: 'success', icon: 'i-ph-check-circle-bold' })
      return { ok: true, value }
    } catch (error) {
      const value = error as { statusCode?: number; status?: number }
      if ((value.statusCode === 401 || value.status === 401) && route.path !== '/login') {
        session.value = { authenticated: false, username: null }
        await navigateTo({ path: '/login', query: { redirect: route.fullPath } })
      } else {
        toast.add({ title: '操作未完成', description: apiErrorMessage(error), color: 'error', icon: 'i-ph-warning-circle-bold' })
      }
      return { ok: false }
    } finally { busy.value = false }
  }
  return { busy, run }
}
