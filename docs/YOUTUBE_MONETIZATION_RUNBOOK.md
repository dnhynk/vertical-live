# YouTube Monetization Launch Runbook

Last updated: 2026-08-18 (aligned with `docs/PROJECT_SPEC.md` v1 in T16)

The account-and-policy side of taking this project to a monetized launch. The spec is the authority: where this
document and `docs/PROJECT_SPEC.md` disagree, the spec wins. Product gates are `docs/ROADMAP.md` (Gate 0–5).

**How claims are sourced here.** Every external claim carries a spec source tag (`[S…]`, resolved in
`docs/PROJECT_SPEC.md` §18) or a URL. URLs carried over from the pre-spec version were **not re-verified in T16**;
confirm them during the Gate 0 account audit (`docs/ops/gate0-checklist.md` §1.2). Platform features change and the
spec requires re-checking before launch (§4).

## 1. Operating Goal

Run a 24/7 unattended vertical Live in which viewers collectively raise an **original creature** — no third-party
characters, names, silhouettes, UI, music or sound effects (spec §3, §12.1, [S17] [S18]) — and monetize through
YouTube's own fan-funding features once the channel qualifies.

Two facts shape everything below:

- **The vertical Live feed has no clickable external links and no live pre-roll/mid-roll ads** [S1]. Ads and external
  conversion are not the core revenue model, and feed impressions are counted from zero and measured, never assumed
  (§4).
- **Before YPP there is no YouTube-internal revenue at all** (§8.1). Until the channel is accepted, this project does
  not say "run it and it earns money on YouTube" (§8.2).

Revenue priority (spec §8.3, in order):

1. **Gifts + Super Chat** — immediate thanks, room-wide celebration, visible presence
2. **Memberships** — badges, emoji, fixed thank-you staging, season recaps
3. **First-party Shopping** — only once the original IP is validated and real products exist
4. **Watch Page ads via simultaneous horizontal+vertical output** — only if dual stream is offered on the account and
   the added cost is justified
5. **Affiliate Shopping** — only when Studio eligibility and product fit are confirmed

Vertical Live feed ads, recommendation reach, and Shorts-view credit for vertical Live are all modelled as **zero**
(§8.3, [S8]).

## 2. What Paid Events May and May Not Buy

This section is a hard boundary, not a design preference (spec §2.4, §8.4, §8.5).

**May buy** — recognition, never power:

- pre-announced fixed thank-you animations and sounds
- a short display of a supporter name or a safe icon (name display requires the identity/consent gate; with the gate
  closed in V1 there is no name display at all — §12.3, §7.4)
- seasonal backgrounds and celebration staging the whole room sees
- time-limited appearance, lighting and music changes
- flat membership benefits: badges, emoji, recaps

**May not buy** — any of these is a blocker:

- paid-only survival, revival, growth, evolution or victory
- vote weight or territory power scaled by payment amount
- paid random rewards, re-rolls, gacha
- cash, gift certificates, crypto or exchangeable value
- prizes drawn among a subset of payers
- spending leaderboards, or paid staging that monopolizes the screen
- "pay or it dies / you lose" guilt or anxiety copy
- anything that gets children to pay or to ask a parent to pay

The creature never dies and never permanently regresses; crisis states such as `asleep`, `exhausted` and
`needs help` recover through free collective action and the passage of time (§6.3). Every paid CTA states clearly
that all core outcomes are reachable through free participation (§8.4).

## 3. Account Gate Checklist

Confirm these in the real YouTube account and record the evidence. The full Gate 0 list is
`docs/ops/gate0-checklist.md` §1.2.

- [ ] Dedicated Google account exists.
- [ ] Brand Account YouTube channel exists.
- [ ] Google account has 2-Step Verification enabled.
- [ ] Channel has advanced features access.
- [ ] Channel has no active Community Guidelines strikes.
- [ ] Channel has no live streaming restrictions in the recent period.
- [ ] Channel is phone/identity verified for live streaming.
- [ ] AdSense for YouTube is linked or ready to set up in YouTube Studio.
- [ ] Audience classification reviewed with evidence, not merely declared (§12.2, [S15] [S29] [S32] — see §6).
- [ ] Live chat and comments can be enabled.
- [ ] Channel country/region supports YPP and the target fan-funding features.
- [ ] The account owner meets the AdSense age/arrangement requirements.
- [ ] Actual per-feature state read from Studio: YPP, Supers, Memberships, Gifts/Jewels, Shopping.

The **actual Studio state is the feature gate** the product uses — thresholds alone do not enable anything (§8.1).

## 4. Monetization Thresholds (spec §8.1, [S8] [S36])

### Expanded YPP (earlier fan-funding access)

- 500 subscribers
- 3 valid public uploads in the last 90 days
- 3,000 valid public watch hours in the last 12 months **or** 3 million valid public Shorts views in the last 90 days

### Full YPP (ad revenue sharing)

- 1,000 subscribers
- 4,000 valid public watch hours in the last 12 months **or** 10 million valid public Shorts views in the last 90 days

Japan is an Expanded YPP and Gifts region, but these numbers are **application thresholds only**. Monetization-policy
compliance, the target region, active strike state, 2-Step Verification, advanced features, an AdSense link, channel
review and per-feature eligibility apply separately (§8.1, [S8] [S10] [S36]).

Two counting limits (§4):

- Watch time from a Live that is **not converted to VOD** is excluded from YPP valid public watch time [S8]. A single
  endless Live is therefore not a YPP-acquisition strategy.
- There is **no official basis** for counting vertical Live views as valid Shorts views, so the revenue model does not
  count them [S8].

### New channels

If the account audit shows a channel that is not yet eligible, YouTube-internal revenue is zero and the spec forbids
assuming one over-12-hour Live can satisfy valid watch hours and the public-upload condition (§8.2). Which public
path produces traffic and YPP-valid metrics — rolling archive under 12 hours, human-reviewed original recap/VOD, or
original Shorts — is chosen by experiment against the real Earn figures and policy review. Bulk automated template
uploads are not a candidate ([S13] [S14]).

## 5. Feature Availability

### Gifts / Jewels

**Japan has had Jewels/Gifts rolling out since 2026-07-27, and turning Gifts on means Super Stickers are not
available on that Live** [S10]. (The pre-spec version of this document said Gifts were listed for the United States
and Taiwan only; that statement is removed as outdated.)

Whether to enable Gifts or keep Super Stickers is an **open decision**, to be made before fan-funding is activated,
on the basis of the actual Japanese Studio feature state and a conversion experiment (§17). Do not design as if both
were available at once (§4) — the product normalizes both event shapes at the contract level so either configuration
works (`packages/contract`, BOARD A-2).

### Super Chat and Super Stickers

Super Chat is kept as a separate path from Gifts (§4). Super Stickers are supported **only in a Gifts-off
configuration** [S10]. Both still require the channel to meet fan-funding requirements, accept the relevant commerce
terms, and keep live chat/comments enabled.

Reference (not re-verified in T16): https://support.google.com/youtube/answer/9277801

### Channel Memberships

Memberships require fan-funding eligibility and acceptance of the Commerce Product Module. In the vertical feed,
**membership purchase from inside the feed is currently not supported on iPhone** [S1] [S2], so membership conversion
is measured per device (§4).

Reference (not re-verified in T16): https://support.google.com/youtube/answer/7636690

### Live reactions and Likes

Live reactions are excluded from V1 inputs: Help describes them as anonymized and the current `liveChatMessages`
type list contains no reaction event [S3] [S35]. Likes are an aggregate gauge candidate only — a difference in
`videos` statistics, not an accurate real-time per-person event [S30]. Recent-subscriber lists are likewise not an
accurate real-time personal event [S31].

## 6. Stream and Channel Eligibility Rules

To keep fan-funding features available on individual live streams:

- The stream must not be Made for Kids. A Made for Kids classification removes Live Chat, Super Chat, Gifts and
  memberships, and **a declaration alone does not settle the classification** (§12.2, [S15] [S29] [S32]).
- Gifts are for eligible **vertical** live streams [S32].
- Live chat/comments must stay enabled.
- The stream must not be age-restricted, unlisted/private, or attached to a fundraiser —
  **확인 필요(출처 없음)**: these three items were carried over from the pre-spec version and have no spec source; verify
  them in Studio during the Gate 0 audit. Reference (not re-verified in T16):
  https://support.google.com/youtube/answer/15535963

## 7. Launch Sequence

The account-side work, mapped onto the product gates (`docs/ROADMAP.md`). The gates are the authority on ordering.

### Before Gate 0 — create the account

Create the dedicated Google account and Brand Account channel, verify by phone, unlock advanced features, enable live
streaming, complete branding with original assets. Detailed checklist: `docs/ACCOUNT_SETUP_FROM_ZERO.md`.

### Gate 0 — audit and approve

Read the real numbers and per-feature states from Studio (§3 above), approve the identity path, the moderation call
table, the provisional availability targets and the public budget/stop-loss line. Checklist:
`docs/ops/gate0-checklist.md`.

### Gate 1 — local world

No account work. The world runs locally against the same event contract as the public broadcast (§15 Gate 1).

### Gate 2 — technical validation on the real account

Private/unlisted streams only. OAuth reconnect, `streamList` collection and REST fallback, broadcast lifecycle and
quota, the OBS host, the data deletion/revocation tests, the broadcast-length experiment and the mobile end-to-end
calibration. Procedures: `docs/ops/gate2-experiments.md`.

The encoder is OBS on a single supervised host (spec §10.2, §10.3, BOARD D-2); the old instruction to run `server.py`
on a cloud machine is removed — that prototype is excluded from the production path (§10.4, §16) and now lives in
`legacy/`.

### Gate 3 — public pilot

Public, Japanese-language, 24 hours unattended, with the moderation call table in place (§12.3). Note what is **not**
done here: raw chat is not shown on screen and viewer names are not displayed while the identity gate is closed
(§12.3, §7.4, BOARD A-1). Scene variation comes from real state, chapter and environment branching, not from
re-labelled repeats (§12.5).

### Gate 4 — traffic and YPP eligibility

Apply for Expanded YPP when the account reaches the thresholds, accept the Base Terms and the Commerce Product
Module, link/verify AdSense, and enable the features Studio actually offers. Map each paid event type onto the event
contract — the adapters exist for all four types already (BOARD A-2).

### Gate 5 — monetized operation

Reconcile the full paid chain (`received → state commit → renderer ACK → safe thank-you display → settlement`) and
compute operating contribution margin from **confirmed** settlement only. Review daily conversion by event type and
adjust which thank-you staging is offered — within §8.4's boundary. Paid staging is never tuned into game power, and
no paid-power variant is built even as a comparison arm (§8.5, §14.2(5)).

## 8. Accounting Basis (spec §8.6)

- Super Chat amounts, tiers and Jewels from the API are **staging and event-analysis data**, not the revenue ledger.
- YouTube Analytics `estimatedRevenue` is an operational estimate; the authority for confirmed YouTube revenue is the
  AdSense for YouTube settlement [S9]. First-party Shopping revenue uses the connected seller's confirmed settlement.
- Commerce Product Module revenue share and the Gifts→Ruby conversion follow official policy, but are validated
  against actual net revenue including taxes, adjustments and refunds [S9] [S11].
- No revenue or conversion-rate targets are invented before a channel baseline, infrastructure costs and a YPP state
  exist. Gate 5's evaluation period includes the AdSense confirmation delay.
- Paid-event fields are API data and are deleted on the field-level retention schedule (§12.4,
  `docs/ops/data-map.md`); the long-term revenue record is the settlement, and long-term KPIs are
  non-identifying aggregates.

## 9. Technical State

The technical work this document used to list as pending is implemented and merged (see `docs/tasks/BOARD.md` for the
per-task state): persistent server-authoritative state (T4, T8), the normalized event contract and fixtures (T1),
replay and latency reporting (T11), the YouTube listener with REST fallback (T9), broadcast lifecycle (T10), OBS
setup and monitoring (T2), the supervisor with alerting, kill switch and dead-man monitor (T12), and field-level
retention/deletion (T13). Windows start-up and archive rotation are T17; the fault matrix and 72-hour soak are T15.

Operating procedure: `docs/ops/runbook-operations.md`.

## 10. Official References

Spec source tags (`docs/PROJECT_SPEC.md` §18) used above: [S1] [S2] [S3] [S8] [S9] [S10] [S11] [S13] [S14] [S15]
[S17] [S18] [S29] [S30] [S31] [S32] [S35] [S36]. URLs for each tag are listed at the end of the spec.

Additional URLs carried over from the pre-spec version of this document (**not re-verified in T16**):

- Super Chat and Super Stickers eligibility: https://support.google.com/youtube/answer/9277801
- Channel memberships: https://support.google.com/youtube/answer/7636690
- Turn on gifts: https://support.google.com/youtube/answer/15534883
</content>
</invoke>
