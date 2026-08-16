// PROTOTYPE (pre-spec v1) — local demo only, not a production path. Removed/replaced in T5 (docs/tasks/TASK_SPECS.md §T5). Random names here violate CLAUDE.md §3 only if used in production.
import React, { Suspense, useEffect, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import usePetStore from './store'
import Pet from './components/Pet'
import Background from './components/Background'

const stats = [
  { key: 'hunger', label: 'Energy', tone: 'energy' },
  { key: 'happiness', label: 'Mood', tone: 'mood' },
  { key: 'cleanliness', label: 'Clean', tone: 'clean' },
  { key: 'life', label: 'Life', tone: 'life' },
]

const localEvents = [
  { type: 'LIKE', label: 'Like', detail: '+small pulse' },
  { type: 'CHAT', label: 'Chat', detail: '!feed', message: '!feed' },
  { type: 'SUBSCRIBE', label: 'Subscribe', detail: '+welcome' },
  { type: 'FEED', label: 'Feed', detail: '+energy' },
  {
    type: 'SUPER_STICKER',
    label: 'Sticker',
    detail: 'JPY 200',
    amount: { valueMicros: 200000000, currency: 'JPY', display: 'JPY 200' },
  },
  {
    type: 'SUPER_CHAT',
    label: 'Super Chat',
    detail: 'JPY 1,000',
    message: 'Revive!',
    amount: { valueMicros: 1000000000, currency: 'JPY', display: 'JPY 1,000' },
  },
  {
    type: 'GIFT',
    label: 'High Gift',
    detail: 'JPY 5,000',
    amount: { valueMicros: 5000000000, currency: 'JPY', display: 'JPY 5,000' },
  },
  { type: 'REVIVE', label: 'Revive', detail: '+life' },
]

const localNames = ['Sora', 'Yuki', 'Hana', 'Ren', 'Aoi']

function randomLocalUser() {
  return {
    name: localNames[Math.floor(Math.random() * localNames.length)],
  }
}

function StatBar({ label, value, tone }) {
  return (
    <div className="stat-row">
      <div className="stat-label">
        <span>{label}</span>
        <strong>{Math.round(value)}%</strong>
      </div>
      <div className="stat-track">
        <div className={`stat-fill ${tone}`} style={{ width: `${Math.max(value, 3)}%` }} />
      </div>
    </div>
  )
}

function BroadcastOverlay() {
  const {
    hunger,
    happiness,
    cleanliness,
    life,
    evolutionXp,
    isDead,
    currentAction,
    lastEvent,
    eventLog,
    totalEvents,
  } = usePetStore()

  const values = { hunger, happiness, cleanliness, life }

  return (
    <div className="broadcast-overlay">
      <header className="broadcast-top">
        <div className="brand-block">
          <span className="live-pill">LIVE</span>
          <h1>Pokemon Pet Lab</h1>
          <p>{isDead ? 'REVIVE NEEDED' : currentAction}</p>
        </div>

        <div className="stat-panel">
          {stats.map((stat) => (
            <StatBar key={stat.key} label={stat.label} value={values[stat.key]} tone={stat.tone} />
          ))}
          <div className="evolution-row">
            <span>Evolution</span>
            <strong>{Math.round(evolutionXp)}%</strong>
          </div>
        </div>
      </header>

      {isDead && (
        <section className="fainted-panel">
          <strong>FAINTED</strong>
          <span>Send a paid revive event to wake it up.</span>
        </section>
      )}

      <footer className="broadcast-bottom">
        <div className="event-ticker">
          <span>{lastEvent ? lastEvent.userName : 'System'}</span>
          <strong>{lastEvent ? lastEvent.label : 'Waiting for live events'}</strong>
          <em>{lastEvent ? lastEvent.message : `${totalEvents} events handled`}</em>
        </div>

        <div className="event-log">
          {eventLog.slice(0, 4).map((event) => (
            <div key={event.id} className="event-log-item">
              <span>{event.timestamp}</span>
              <strong>{event.userName}</strong>
              <em>{event.label}</em>
            </div>
          ))}
        </div>
      </footer>
    </div>
  )
}

function BroadcastStage() {
  return (
    <section className="stage-shell" aria-label="9:16 live broadcast preview">
      <div className="phone-stage">
        <Canvas className="stage-canvas" camera={{ position: [0, 0, 5] }}>
          <ambientLight intensity={0.55} />
          <directionalLight position={[10, 10, 5]} intensity={1.1} />
          <pointLight position={[-3, 2, 3]} intensity={1.2} color="#7dd3fc" />

          <Background />

          <Suspense fallback={<Html center>Loading...</Html>}>
            <Pet />
          </Suspense>
        </Canvas>
        <BroadcastOverlay />
      </div>
    </section>
  )
}

function LocalEventPanel() {
  const {
    dispatchEvent,
    forceDeath,
    resetPet,
    socketStatus,
    hunger,
    happiness,
    cleanliness,
    life,
    evolutionXp,
    totalEvents,
    totalRevenueMicros,
  } = usePetStore()

  const fire = (event) => {
    dispatchEvent({
      ...event,
      user: randomLocalUser(),
      source: 'local-panel',
      timestamp: new Date().toISOString(),
    })
  }

  return (
    <aside className="control-panel">
      <div className="panel-section">
        <div className="panel-heading">
          <span>Local Console</span>
          <strong>{socketStatus}</strong>
        </div>
        <div className="event-grid">
          {localEvents.map((event) => (
            <button key={event.label} className="event-button" onClick={() => fire(event)}>
              <strong>{event.label}</strong>
              <span>{event.detail}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="panel-section">
        <div className="panel-heading">
          <span>State</span>
          <strong>{totalEvents} events</strong>
        </div>
        <dl className="state-grid">
          <div>
            <dt>Energy</dt>
            <dd>{hunger}%</dd>
          </div>
          <div>
            <dt>Mood</dt>
            <dd>{happiness}%</dd>
          </div>
          <div>
            <dt>Clean</dt>
            <dd>{cleanliness}%</dd>
          </div>
          <div>
            <dt>Life</dt>
            <dd>{life}%</dd>
          </div>
          <div>
            <dt>Evolution</dt>
            <dd>{evolutionXp}%</dd>
          </div>
          <div>
            <dt>Revenue</dt>
            <dd>JPY {Math.round(totalRevenueMicros / 1000000).toLocaleString()}</dd>
          </div>
        </dl>
      </div>

      <div className="panel-actions">
        <button className="utility-button danger" onClick={forceDeath}>
          Force faint
        </button>
        <button className="utility-button" onClick={resetPet}>
          Reset pet
        </button>
      </div>

      <div className="panel-note">
        OBS target URL: <code>?mode=broadcast</code>
      </div>
    </aside>
  )
}

export default function App() {
  const tick = usePetStore((state) => state.tick)
  const isBroadcastMode = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('mode') === 'broadcast'
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => tick(), 1000)
    return () => window.clearInterval(timer)
  }, [tick])

  return (
    <div className={`app-shell ${isBroadcastMode ? 'broadcast-mode' : ''}`}>
      <BroadcastStage />
      {!isBroadcastMode && <LocalEventPanel />}
    </div>
  )
}
