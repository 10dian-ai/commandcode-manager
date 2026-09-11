export default defineNuxtRouteMiddleware(async (to) => {
  const { ensureSession } = useAuth()
  const session = await ensureSession()
  if (!session.authenticated && to.path !== '/login') {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
  if (session.authenticated && to.path === '/login') return navigateTo('/')
})
