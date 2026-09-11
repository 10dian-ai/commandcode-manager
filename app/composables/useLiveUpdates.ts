export function useLiveUpdates() {
  const revision = useState('live-revision', () => 0)
  const connection = useState<'connecting' | 'live' | 'reconnecting'>('live-connection', () => 'connecting')
  let source: EventSource | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let hasConnected = false
  onMounted(() => {
    connection.value = 'connecting'
    source = new EventSource('/api/events')
    source.onopen = () => {
      connection.value = 'live'
      if (hasConnected) revision.value++
      hasConnected = true
    }
    source.onerror = () => { connection.value = 'reconnecting' }
    source.addEventListener('update', () => {
      if (timer) return
      timer = setTimeout(() => { revision.value++; timer = undefined }, 700)
    })
  })
  onBeforeUnmount(() => { source?.close(); if (timer) clearTimeout(timer) })
  return { connection }
}
export function useLiveRefresh(refresh: () => unknown) {
  const revision = useState('live-revision', () => 0)
  watch(revision, () => { void refresh() })
}
