import { JA_NATIVE_REVIEW } from '../i18n/index'
import { useConnectionVersion, useLogEntries, useTick } from '../hooks'
import type { RendererRuntime } from '../runtime'
import { paletteFor } from '../visual/palette'
import DevInjector from './DevInjector'

/**
 * `?mode=dev` diagnostics: connection state, revisions, effect count and the
 * health signals of spec §9.4(4), plus the T11 injection controls.
 *
 * The panel only shows values the renderer produced itself — codes, counters,
 * ids and i18n keys — because it is on screen and raw chat may not be
 * (spec §12.3).
 *
 * `config.wsUrl` and `config.apiUrl` carry no token by construction
 * (`config.ts`), so the addresses below are safe to draw. Never render
 * `authenticatedWsUrl()` or `config.simToken` here: those carry vault secrets
 * (spec §10.2, `DevPanel.test.tsx`).
 */
export interface DevPanelProps {
  runtime: RendererRuntime
}

const TICK_INTERVAL_MS = 500

export default function DevPanel({ runtime }: DevPanelProps) {
  useConnectionVersion(runtime.connection)
  useTick(TICK_INTERVAL_MS)
  const entries = useLogEntries(runtime.log)
  const snapshot = runtime.model.snapshot

  return (
    <aside className="dev-panel" data-testid="dev-panel">
      <dl className="dev-grid">
        <dt>ws</dt>
        <dd data-testid="dev-ws-url">{runtime.config.wsUrl}</dd>
        <dt>api</dt>
        <dd data-testid="dev-api-url">{runtime.config.apiUrl}</dd>
        <dt>status</dt>
        <dd data-testid="dev-status">{runtime.connection.status}</dd>
        <dt>reconnects</dt>
        <dd>{runtime.connection.reconnectCount}</dd>
        <dt>rejected</dt>
        <dd>{runtime.connection.rejectedMessageCount}</dd>
        <dt>rendererId</dt>
        <dd>{runtime.config.rendererId}</dd>
        <dt>revision (snapshot / acked)</dt>
        <dd data-testid="dev-revision">
          {snapshot === null ? '—' : snapshot.stateRevision} /{' '}
          {runtime.model.lastAppliedStateRevision ?? '—'}
        </dd>
        <dt>processedIngestSeq</dt>
        <dd>{snapshot === null ? '—' : snapshot.processedIngestSeq}</dd>
        <dt>input (mode / enabled)</dt>
        <dd data-testid="dev-input">
          {snapshot === null ? '—' : snapshot.inputMode} /{' '}
          {snapshot === null ? '—' : String(snapshot.interactionEnabled)}
        </dd>
        <dt>palette</dt>
        <dd data-testid="dev-palette">{paletteFor(snapshot).paletteId}</dd>
        <dt>effects (started / active)</dt>
        <dd data-testid="dev-effects">
          {runtime.model.effectStartCount} / {runtime.model.activeEffects.length}
        </dd>
        <dt>frames / fps</dt>
        <dd data-testid="dev-frames">
          {runtime.health.frameCounter} / {runtime.health.fps.toFixed(1)}
        </dd>
        <dt>webgl</dt>
        <dd data-testid="dev-webgl">
          {runtime.health.webglContextLost ? 'lost' : 'ok'} (lost {runtime.webgl.lossCount}, restore
          attempts {runtime.webgl.restoreAttempts}, restored {runtime.webgl.restoredCount})
        </dd>
        <dt>ja nativeReview</dt>
        <dd>{JA_NATIVE_REVIEW}</dd>
        <dt>provisional</dt>
        <dd>{runtime.config.provisional.join(', ')}</dd>
      </dl>
      <DevInjector runtime={runtime} />
      <ol className="dev-log" data-testid="dev-log">
        {entries
          .slice(-20)
          .reverse()
          .map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={`dev-log-${entry.level}`}>
              <span className="dev-log-code">{entry.code}</span>
              {entry.detail === null ? null : (
                <span className="dev-log-detail">{entry.detail}</span>
              )}
            </li>
          ))}
      </ol>
    </aside>
  )
}
