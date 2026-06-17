type ObservabilityListener = () => void

const listeners = new Set<ObservabilityListener>()

export function subscribeObservabilityUpdates(listener: ObservabilityListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function broadcastObservabilityUpdate(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch {
      listeners.delete(listener)
    }
  }
}

export function observabilitySubscriberCount(): number {
  return listeners.size
}
