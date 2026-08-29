import type { Alias, Translate } from '../i18n/index'
import {
  CONSENT_COMMANDS,
  commandLabel,
  consentCommandLabel,
  type CtaState,
} from '../read-model/cta'
import { CONSENT_RETENTION_DAYS } from '../read-model/identity'

/**
 * The free-command call to action (spec §5.2(3), §7.1) and the open decision
 * (spec §6.2, §6.4).
 *
 * Three things this component must keep saying:
 *
 * - what to type, in the three forms §7.1 accepts (Japanese, emoji, English) and
 *   in those forms only, so what the screen shows is literally what a viewer
 *   sends — an icon of our own next to them would be a fourth thing that does
 *   not work in chat;
 * - that everything is reachable for free (spec §8.5) — the note sits with the
 *   CTA, not only next to a paid surface, and nothing on this screen offers a
 *   paid alternative to it;
 * - how a name gets onto the screen and how it comes off again (BOARD D-9) —
 *   **but only while the server is actually accepting those commands.** The gate
 *   is closed by default, and with it closed the parser refuses both spellings
 *   (`consent_disabled`), so the notice would be inviting viewers to send
 *   something that gets thrown away. It was on air that way through the public
 *   broadcast of 2026-08-29. `identityConsentOffered` comes from the snapshot;
 *   the renderer never decides it. When it is offered, the
 *   notice is one line — only a viewer who sends the consent command is named,
 *   the withdrawal command deletes the record immediately, and 30 days without
 *   activity deletes it by itself — and the two commands are shown next to it in
 *   the same spellings the parser accepts. **Both languages say all three
 *   things**: the English alias is not a shorter notice but the same one
 *   (`docs/ops/identity-consent.md` §2.1, `JOIN = show my name · LEAVE = delete
 *   it`, plus the 30 days), because a viewer who reads only the English line
 *   would otherwise be told how to give a name and not how to take it back. The
 *   full text lives in the channel description and the pinned comment (§2.2);
 *   what has to be *on air* is the line and the two commands;
 * - nothing at all, when the server reports `interactionEnabled: false`. Input or
 *   renderer ACK is unhealthy then, so the CTA disappears and the screen shows
 *   `ui.interactionPaused` instead (spec §9.2). The renderer never decides this
 *   itself. The consent notice goes with it: an invitation to hand over a name
 *   while commands are not being applied would be an invitation to nothing.
 */
export interface CtaProps {
  cta: CtaState
  translate: Translate
  alias: Alias
}

export default function Cta({ cta, translate, alias }: CtaProps) {
  if (!cta.enabled) {
    return (
      <div className="cta cta-paused" data-testid="interaction-paused">
        <p className="cta-paused-title">{translate('ui.interactionPaused')}</p>
        <p className="cta-paused-note">{translate('ui.interactionPausedNote')}</p>
      </div>
    )
  }

  return (
    <div className="cta" data-testid="cta">
      {cta.choice === null ? null : (
        <ul className="cta-choices" data-testid="cta-choices">
          {cta.choice.options.map((option) => (
            <li
              className="cta-choice"
              key={option.choiceId}
              data-testid={`choice-${option.choiceId}`}
            >
              {option.commandName === null ? null : (
                <span className="cta-choice-key">{commandLabel(option.commandName).en}</span>
              )}
              <span className="cta-choice-text">{translate(option.labelKey)}</span>
              <span className="cta-choice-en">{alias(option.labelKey)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="cta-head">
        <h2 className="slot-label">
          <span className="slot-label-ja">{translate('ui.cta.title')}</span>
          <span className="slot-label-en">{alias('ui.cta.title')}</span>
        </h2>
        <span className="cta-hint">{translate('ui.cta.hint')}</span>
      </div>

      <ul className="cta-commands">
        {cta.commands.map((name) => {
          const label = commandLabel(name)
          return (
            <li key={name} className="cta-command" data-testid={`cta-command-${name}`}>
              <span className="cta-text">{label.ja ?? label.en}</span>
              {label.emoji === null ? null : <span className="cta-emoji">{label.emoji}</span>}
              <span className="cta-en">{label.en}</span>
            </li>
          )
        })}
      </ul>

      <p className="cta-free-note" data-testid="cta-free-note">
        {translate('ui.cta.freeNote')}
      </p>

      {!cta.identityConsentOffered ? null : (
        <div className="cta-identity" data-testid="cta-identity">
          <p className="cta-identity-notice">
            <span className="cta-identity-ja" data-testid="cta-identity-notice">
              {translate('ui.identity.notice', {
                join: consentCommandLabel('JOIN').ja,
                leave: consentCommandLabel('LEAVE').ja,
                days: CONSENT_RETENTION_DAYS,
              })}
            </span>
            <span className="cta-identity-en" data-testid="cta-identity-notice-en">
              {alias('ui.identity.notice', {
                join: consentCommandLabel('JOIN').en,
                leave: consentCommandLabel('LEAVE').en,
                days: CONSENT_RETENTION_DAYS,
              })}
            </span>
          </p>

          <ul className="cta-identity-commands">
            {CONSENT_COMMANDS.map((name) => {
              const label = consentCommandLabel(name)
              return (
                <li
                  key={name}
                  className="cta-identity-command"
                  data-testid={`cta-consent-command-${name}`}
                >
                  <span className="cta-text">{label.ja}</span>
                  <span className="cta-en">{label.en}</span>
                  <span className="cta-identity-meaning">{translate(label.meaningKey)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
