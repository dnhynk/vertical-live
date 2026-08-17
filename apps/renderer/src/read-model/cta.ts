import { COMMAND_ALIASES, type CommandName, type WorldSnapshot } from '@vl/contract'

/**
 * What the screen invites a viewer to do (spec §5.2(3), §7.1) and what the room
 * is about to decide (spec §6.2, §6.4).
 *
 * The call to action is the three free care commands, always the same three, so
 * a viewer arriving mid-stream can act without reading a menu — and next to them
 * the screen states that everything is reachable for free (spec §8.5, the note
 * every paid product surface owes). Whether the CTA is live at all is the
 * server's decision through `interactionEnabled` (spec §9.2); the renderer never
 * decides it.
 *
 * The open decision is a separate block rather than a replacement for the CTA:
 * while the identity gate is closed there is no per-user branch vote at all
 * (BOARD A-1, A-9), so the options are shown as the director's preview and carry
 * a vote command only when the server put one there. The tally of an open
 * aggregate window belongs to the mode badge (spec §6.4) and is selected in
 * `display.ts`.
 *
 * This supersedes the T5 precedence (choices → tallies → allowlist, coordinator
 * answer of 2026-08-17): TASK_SPECS §T14 fixes the CTA as "three free commands
 * plus the free-participation note", so the other two sources moved to the
 * surfaces that spec §6.4 and §6.2 assign them to instead of competing for the
 * same one.
 */

/** The always-available care commands of spec §7.1. */
export const FREE_CARE_COMMANDS: readonly CommandName[] = ['FEED', 'PLAY', 'PET']

export interface ChoiceOptionView {
  readonly choiceId: string
  readonly labelKey: string
  /** Vote command, `null` while the identity gate is closed (spec §6.4). */
  readonly commandName: CommandName | null
}

export interface ChoiceView {
  readonly options: readonly ChoiceOptionView[]
  readonly closesAt: string
}

export interface CtaState {
  readonly enabled: boolean
  readonly commands: readonly CommandName[]
  readonly choice: ChoiceView | null
}

export function selectCta(snapshot: WorldSnapshot | null): CtaState {
  const enabled = snapshot?.interactionEnabled ?? false
  const mission = snapshot?.mission ?? null
  const closesAt = mission?.choiceClosesAt ?? null

  return {
    enabled,
    commands: FREE_CARE_COMMANDS,
    choice:
      mission === null || closesAt === null || mission.choices.length === 0
        ? null
        : {
            options: mission.choices.map((choice) => ({
              choiceId: choice.choiceId,
              labelKey: choice.labelKey,
              commandName: choice.commandName,
            })),
            closesAt,
          },
  }
}

/** Original icons for the commands §7.1 gives an icon alias to; see `visual/icons.tsx`. */
const COMMAND_ICON_IDS: Readonly<Partial<Record<CommandName, string>>> = {
  FEED: 'icon_command_feed',
  PLAY: 'icon_command_play',
  PET: 'icon_command_pet',
}

export interface CommandLabel {
  readonly name: CommandName
  /** Japanese alias a viewer types (spec §7.1); `null` where §7.1 defines none. */
  readonly ja: string | null
  /** Emoji alias a viewer types; `null` where §7.1 defines none. */
  readonly emoji: string | null
  /** Short English alias (spec §5.1); falls back to the canonical name. */
  readonly en: string
  readonly iconId: string | null
}

/**
 * Japanese wording, emoji and short English alias all come from the contract
 * alias table, which is the §7.1 data itself. Nothing is invented here: a
 * command §7.1 gives no Japanese or emoji alias to (the vote letters) shows
 * none.
 */
export function commandLabel(name: CommandName): CommandLabel {
  const entry = COMMAND_ALIASES[name]
  return {
    name,
    ja: entry.ja[0] ?? null,
    emoji: entry.icons[0] ?? null,
    en: entry.en[0] ?? name,
    iconId: COMMAND_ICON_IDS[name] ?? null,
  }
}
