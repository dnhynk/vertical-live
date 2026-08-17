import type {
  HealthAggregate,
  PreflightResult,
  SafeStopTrigger,
  SupervisedComponent,
  SupervisorState,
} from './types.js'

/**
 * The state machine of spec §9.2, as a pure function.
 *
 * `offline → starting → live → degraded → recovering → live | safe_stopped`
 *
 * Everything it needs is an argument, so the whole transition table is testable
 * as a table (TASK_SPECS §T12 acceptance 1) and no transition can depend on a
 * timer, a socket or a global. Two rules dominate the rest:
 *
 * 1. **Only aggregated signals move the machine.** A producer never says
 *    "degraded"; the aggregate does (§9.4 → §9.2).
 * 2. **`safe_stopped` is terminal.** Spec §9.2 and §9.1: rights, policy, data
 *    integrity, account actions and moderation faults must not be restarted
 *    automatically. Re-entering the run is a human action, which in this process
 *    means a new process.
 */

export interface TransitionInput {
  readonly aggregate: HealthAggregate
  /** Result of the `starting` pre-checks; `null` until the first one has run. */
  readonly preflight: PreflightResult | null
  /** A restart supervisor currently has an attempt in flight (spec §9.2). */
  readonly recovering: boolean
  /** Set once a safe-stop condition has been observed; never cleared here. */
  readonly safeStop: SafeStopTrigger | null
  /** The process has been asked to run (`Supervisor.start()`). */
  readonly startRequested: boolean
}

export interface Transition {
  readonly from: SupervisorState
  readonly to: SupervisorState
  /** Machine-stable token, reported on `/health` and in the alert. */
  readonly reason: string
  readonly changed: boolean
}

export function nextSupervisorState(from: SupervisorState, input: TransitionInput): Transition {
  const to = decide(from, input)
  return {
    from,
    to: to.state,
    reason: to.reason,
    changed: to.state !== from,
  }
}

interface Decision {
  readonly state: SupervisorState
  readonly reason: string
}

function decide(from: SupervisorState, input: TransitionInput): Decision {
  // 1. Terminal state first: nothing below can move out of it.
  if (from === 'safe_stopped') {
    return { state: 'safe_stopped', reason: 'safe_stopped_is_terminal' }
  }
  // 2. A safe-stop condition wins over every health verdict, from any state.
  if (input.safeStop !== null) {
    return { state: 'safe_stopped', reason: `safe_stop:${input.safeStop.kind}` }
  }

  if (from === 'offline') {
    return input.startRequested
      ? { state: 'starting', reason: 'start_requested' }
      : { state: 'offline', reason: 'not_started' }
  }

  if (from === 'starting') {
    if (input.preflight === null) {
      return { state: 'starting', reason: 'preflight_pending' }
    }
    if (!input.preflight.passed) {
      return {
        state: 'starting',
        reason: `preflight_failed:${input.preflight.failed.join('+')}`,
      }
    }
    // Pre-checks passed. §9.2 defines `live` as "영상 송출, chat listener, 상태
    // tick, 렌더러 heartbeat가 모두 정상" — which is what the aggregate says,
    // so a run that comes up already unhealthy lands in `degraded`, not in a
    // `live` it never was.
    return healthyDecision(input, 'preflight_passed')
  }

  // live | degraded | recovering — all decided by the same aggregate, so the
  // machine cannot report a broadcast as live while a family says otherwise.
  return healthyDecision(input, 'signals')
}

function healthyDecision(input: TransitionInput, cause: string): Decision {
  const degraded = input.aggregate.degradedFamilies
  if (degraded.length === 0) {
    return { state: 'live', reason: `${cause}:all_families_ok` }
  }
  if (input.recovering) {
    return { state: 'recovering', reason: `recovering:${degraded.join('+')}` }
  }
  return { state: 'degraded', reason: `degraded:${degraded.join('+')}` }
}

/**
 * Which component's restart supervisor should act on the current aggregate.
 *
 * Deliberately partial. Two degraded families have **no** local restart that
 * would help, and inventing one would make things worse:
 *
 * - `frame_loss` (§9.4(7)): congestion and skipped frames are load, not a
 *   crashed component. Restarting the output drops the stream on purpose to fix
 *   a stream that is still up.
 * - `youtube_broadcast` lifecycle and stream *health* (§9.4(6)): the broadcast
 *   lifecycle belongs to T10, which reconciles it against YouTube and asks for
 *   `safe_stopped` itself when it cannot. A `streamStatus` that says no ingest
 *   is arriving is the exception — that one is the local encoder's output.
 *
 * Both still make the machine `degraded` and still alert; they just do not get
 * a restart they have no use for.
 */
export function componentsToRestart(aggregate: HealthAggregate): readonly SupervisedComponent[] {
  const components: SupervisedComponent[] = []
  const add = (component: SupervisedComponent): void => {
    if (!components.includes(component)) components.push(component)
  }

  for (const family of aggregate.degradedFamilies) {
    const verdict = aggregate.families[family]
    const reason = verdict.reason ?? ''
    switch (family) {
      case 'coordinator':
      case 'state_commit':
        add('engine')
        break
      case 'renderer':
        add('renderer-source')
        break
      case 'chat_transport':
        add('chat-source')
        break
      case 'obs_output':
        // An OBS we cannot reach at all is a connection problem; an OBS that
        // answers but is not sending is an output problem.
        add(isUnreachable(reason) ? 'obs-connection' : 'obs-stream')
        break
      case 'youtube_broadcast':
        if (reason.startsWith('stream_')) add('obs-stream')
        break
      case 'frame_loss':
      case 'dead_man':
        break
    }
  }
  return components
}

function isUnreachable(reason: string): boolean {
  return (
    reason.startsWith('unobservable:') ||
    reason.includes('obs_not_connected') ||
    reason.startsWith('request_failed')
  )
}
