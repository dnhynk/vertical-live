// PROTOTYPE (pre-spec v1) — local demo only, not a production path. Removed/replaced in T5 (docs/tasks/TASK_SPECS.md §T5). Random names here violate CLAUDE.md §3 only if used in production.
import { create } from 'zustand'

const clamp = (value, min = 0, max = 100) => Math.min(Math.max(value, min), max)
const clampStat = (value) => clamp(Math.round(value))

const TEST_NAMES = ['Sora', 'Yuki', 'Hana', 'Ren', 'Aoi', 'Mika', 'Kaito']

function randomName() {
  return TEST_NAMES[Math.floor(Math.random() * TEST_NAMES.length)]
}

function amountMicros(event) {
  return event.amount?.valueMicros || event.amountMicros || 0
}

function paidTier(event) {
  const micros = amountMicros(event)
  if (micros >= 5000000000) return 3
  if (micros >= 1000000000) return 2
  if (micros > 0) return 1
  return event.tier || 0
}

function compactEvent(event, label) {
  const userName = event.user?.name || event.authorName || randomName()

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: event.type,
    label,
    userName,
    message: event.message || event.amount?.display || event.count || '',
    timestamp: new Date().toLocaleTimeString(),
  }
}

function startAction(set, get, action, duration = 2200) {
  const actionNonce = get().actionNonce + 1

  set({
    currentAction: action,
    isEating: action === 'Eat',
    actionNonce,
  })

  window.setTimeout(() => {
    const state = get()
    if (state.actionNonce === actionNonce && !state.isDead) {
      set({ currentAction: 'Idle', isEating: false })
    }
  }, duration)
}

const usePetStore = create((set, get) => ({
  currentAction: 'Idle',
  isEating: false,
  isDead: false,
  actionNonce: 0,

  hunger: 100,
  happiness: 78,
  cleanliness: 82,
  life: 100,
  evolutionXp: 0,

  totalEvents: 0,
  totalRevenueMicros: 0,
  socketStatus: 'idle',
  lastEvent: null,
  eventLog: [],

  feedPet: () => get().dispatchEvent({ type: 'FEED', user: { name: 'Local' } }),
  revivePet: () => get().dispatchEvent({ type: 'REVIVE', user: { name: 'Local' } }),

  forceDeath: () => {
    const event = compactEvent({ type: 'FORCE_DEATH', user: { name: 'System' } }, 'Forced faint')
    set((state) => ({
      isDead: true,
      currentAction: 'Dead',
      isEating: false,
      hunger: 0,
      happiness: 0,
      life: 0,
      lastEvent: event,
      eventLog: [event, ...state.eventLog].slice(0, 8),
      totalEvents: state.totalEvents + 1,
    }))
  },

  resetPet: () => {
    const event = compactEvent({ type: 'RESET', user: { name: 'System' } }, 'Reset')
    set((state) => ({
      currentAction: 'Idle',
      isEating: false,
      isDead: false,
      hunger: 100,
      happiness: 78,
      cleanliness: 82,
      life: 100,
      evolutionXp: 0,
      lastEvent: event,
      eventLog: [event, ...state.eventLog].slice(0, 8),
    }))
  },

  dispatchEvent: (rawEvent) => {
    const event = {
      source: 'local',
      ...rawEvent,
      type: String(rawEvent.type || 'CHAT').toUpperCase(),
    }

    const state = get()
    const tier = paidTier(event)
    const paidMicros = amountMicros(event)
    const canRevive = ['REVIVE', 'SUPER_CHAT', 'SUPER_STICKER', 'GIFT', 'JEWEL_GIFT'].includes(
      event.type,
    )
    const deadAndIgnored = state.isDead && !canRevive

    let gain = { hunger: 0, happiness: 0, cleanliness: 0, life: 0, evolutionXp: 0 }
    let action = 'Cheer'
    let label = event.type
    let duration = 2200

    if (deadAndIgnored) {
      const logged = compactEvent(event, 'Ignored while fainted')
      set((current) => ({
        lastEvent: logged,
        eventLog: [logged, ...current.eventLog].slice(0, 8),
        totalEvents: current.totalEvents + 1,
      }))
      return
    }

    switch (event.type) {
      case 'LIKE':
        gain = { hunger: 2, happiness: 1, cleanliness: 0, life: 0, evolutionXp: 1 }
        action = 'Cheer'
        label = 'Like boost'
        break
      case 'CHAT':
        gain = { hunger: 1, happiness: 3, cleanliness: 0, life: 0, evolutionXp: 1 }
        action = 'Wave'
        label = event.message || 'Chat'
        break
      case 'SUBSCRIBE':
        gain = { hunger: 4, happiness: 8, cleanliness: 0, life: 2, evolutionXp: 5 }
        action = 'Dance'
        label = 'New subscriber'
        duration = 3200
        break
      case 'FEED':
        gain = { hunger: 12, happiness: 2, cleanliness: -1, life: 2, evolutionXp: 2 }
        action = 'Eat'
        label = 'Snack'
        duration = 3000
        break
      case 'SUPER_STICKER':
        gain = {
          hunger: 12 + tier * 4,
          happiness: 10 + tier * 4,
          cleanliness: 3,
          life: 6,
          evolutionXp: 8 + tier * 3,
        }
        action = tier >= 2 ? 'Dance' : 'Cheer'
        label = event.amount?.display || 'Super Sticker'
        duration = 3200
        break
      case 'SUPER_CHAT':
        gain = {
          hunger: 18 + tier * 8,
          happiness: 16 + tier * 8,
          cleanliness: 5,
          life: 12 + tier * 8,
          evolutionXp: 15 + tier * 8,
        }
        action = tier >= 3 ? 'BigGift' : 'Dance'
        label = event.amount?.display || 'Super Chat'
        duration = tier >= 3 ? 5200 : 3600
        break
      case 'GIFT':
      case 'JEWEL_GIFT':
        gain = {
          hunger: 20 + tier * 10,
          happiness: 20 + tier * 10,
          cleanliness: 8,
          life: 18 + tier * 10,
          evolutionXp: 20 + tier * 10,
        }
        action = 'BigGift'
        label = event.amount?.display || 'Gift'
        duration = 5200
        break
      case 'REVIVE':
        gain = { hunger: 45, happiness: 25, cleanliness: 10, life: 60, evolutionXp: 10 }
        action = 'Revive'
        label = 'Revive'
        duration = 5200
        break
      default:
        gain = { hunger: 2, happiness: 2, cleanliness: 0, life: 0, evolutionXp: 1 }
        action = 'Wave'
        label = event.type
        break
    }

    const revived = state.isDead && canRevive
    const nextLife = revived ? Math.max(45, gain.life) : clampStat(state.life + gain.life)
    const nextHunger = revived ? Math.max(35, gain.hunger) : clampStat(state.hunger + gain.hunger)
    const nextHappiness = revived
      ? Math.max(30, gain.happiness)
      : clampStat(state.happiness + gain.happiness)
    const nextCleanliness = clampStat(state.cleanliness + gain.cleanliness)
    const nextEvolutionXp = clampStat(state.evolutionXp + gain.evolutionXp)
    const logged = compactEvent(event, label)

    set((current) => ({
      isDead: false,
      hunger: nextHunger,
      happiness: nextHappiness,
      cleanliness: nextCleanliness,
      life: nextLife,
      evolutionXp: nextEvolutionXp,
      totalRevenueMicros: current.totalRevenueMicros + paidMicros,
      totalEvents: current.totalEvents + 1,
      lastEvent: logged,
      eventLog: [logged, ...current.eventLog].slice(0, 8),
    }))

    startAction(set, get, action, duration)
  },

  tick: () => {
    const state = get()
    if (state.isDead) return

    const hunger = clamp(state.hunger - 1)
    const happiness = clamp(state.happiness - 0.35)
    const cleanliness = clamp(state.cleanliness - 0.18)
    const dangerDrain = hunger <= 0 ? 5 : hunger < 20 ? 1.5 : happiness <= 0 ? 2 : 0
    const life = clamp(state.life - dangerDrain)

    if (life <= 0 || hunger <= 0) {
      const event = compactEvent({ type: 'FAINTED', user: { name: 'System' } }, 'Fainted')
      set((current) => ({
        isDead: true,
        currentAction: 'Dead',
        isEating: false,
        hunger: 0,
        life: 0,
        lastEvent: event,
        eventLog: [event, ...current.eventLog].slice(0, 8),
      }))
      return
    }

    set({
      hunger: clampStat(hunger),
      happiness: clampStat(happiness),
      cleanliness: clampStat(cleanliness),
      life: clampStat(life),
    })
  },
}))

function connectSocket() {
  if (typeof window === 'undefined') return

  usePetStore.setState({ socketStatus: 'connecting' })
  const socket = new WebSocket('ws://localhost:5002/ws')

  socket.onopen = () => usePetStore.setState({ socketStatus: 'connected' })

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      usePetStore.getState().dispatchEvent({ source: 'youtube', ...data })
    } catch (error) {
      console.error('Event parse error:', error)
    }
  }

  socket.onclose = () => {
    usePetStore.setState({ socketStatus: 'reconnecting' })
    window.setTimeout(connectSocket, 3000)
  }

  socket.onerror = () => {
    usePetStore.setState({ socketStatus: 'error' })
    socket.close()
  }
}

connectSocket()

export default usePetStore
