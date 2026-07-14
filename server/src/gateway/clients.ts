// Connected-robot registry. Owns the `clients` Map and the connection-id counter,
// exposing a small API (add/get/delete/all + resolveTargets) so callers never
// touch the Map directly. This is the boundary a future process split would cut
// along (the registry could become an RPC surface). Terminal module — imports no
// other #gateway module except the shared Session type.

import type { Session } from '#gateway/types.ts'

// Connected robots, keyed by connection id. Each value is the connection's
// `session` with control methods (speak/prompt/body) for webhooks + the UI.
const clients = new Map<number, Session>()
let nextId = 1

export const nextClientId = () => nextId++
export const addClient = (session: Session) => clients.set(session.id, session)
export const getClient = (id: number) => clients.get(id)
export const deleteClient = (id: number) => clients.delete(id)
export const allClients = () => [...clients.values()]
export const clientCount = () => clients.size

// Resolve which connected robots an action targets. `target` = a client id
// (number) OR a hardware_id (stable per-unit), or undefined = all connected
// robots (usually just one). hardware_id targeting lets the UI/webhook address
// a specific unit that keeps the same id across reconnects.
export const resolveTargets = (target) => {
  if (target != null) {
    const byId = clients.get(Number(target))
    if (byId) return [byId]
    const byHw = [...clients.values()].filter((c) => c.hardwareId === target)
    return byHw
  }
  return [...clients.values()]
}
