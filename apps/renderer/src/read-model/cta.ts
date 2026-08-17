import { COMMAND_ALIASES, type CommandName, type WorldSnapshot } from '@vl/contract'

/**
 * Which free commands the screen offers (spec §5.2(3), §7.1).
 *
 * The snapshot has no field that names a call to action, so the source is fixed
 * by the coordinator's answer of 2026-08-17 (ticket "Questions asked", option
 * A): prefer what the snapshot itself puts on offer, and otherwise show the
 * §7.1 free-command allowlist, which is contract data in `COMMAND_ALIASES`.
 * Nothing here is invented state — whether the CTA is live at all is decided by
 * the server through `interactionEnabled` (spec §9.2).
 */

/** The always-available care commands; vote commands need an open window. */
export const FREE_CARE_COMMANDS: readonly CommandName[] = ['FEED', 'PLAY', 'PET']

export type CtaSource = 'choices' | 'aggregate' | 'allowlist'

export interface CtaState {
  readonly enabled: boolean
  readonly commands: readonly CommandName[]
  readonly source: CtaSource
}

export function selectCta(snapshot: WorldSnapshot | null): CtaState {
  const enabled = snapshot?.interactionEnabled ?? false

  const choiceCommands =
    snapshot?.mission !== null &&
    snapshot?.mission !== undefined &&
    snapshot.mission.choiceClosesAt !== null
      ? snapshot.mission.choices
          .map((choice) => choice.commandName)
          .filter((name): name is CommandName => name !== null)
      : []
  if (choiceCommands.length > 0) return { enabled, commands: choiceCommands, source: 'choices' }

  const tallyCommands = snapshot?.display.aggregateWindow?.tallies.map((tally) => tally.commandName)
  if (tallyCommands !== undefined && tallyCommands.length > 0) {
    return { enabled, commands: tallyCommands, source: 'aggregate' }
  }

  return { enabled, commands: FREE_CARE_COMMANDS, source: 'allowlist' }
}

/** Japanese wording, icon and short English alias all come from the contract. */
export function commandLabel(name: CommandName): { icon: string | null; label: string } {
  const entry = COMMAND_ALIASES[name]
  return {
    icon: entry.icons[0] ?? null,
    label: entry.ja[0] ?? entry.en[0] ?? name,
  }
}
