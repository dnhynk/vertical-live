# Account Setup From Zero

Last updated: 2026-08-18 (aligned with `docs/PROJECT_SPEC.md` v1 in T16)

The account path for launching this project from nothing. The spec is the authority: where this document and
`docs/PROJECT_SPEC.md` disagree, the spec wins.

**How claims are sourced here.** Every external claim carries either a spec source tag (`[S…]`, resolved in
`docs/PROJECT_SPEC.md` §18) or a URL. URLs that were carried over from the pre-spec version of this document were
**not re-verified in T16** — treat them as pointers, and confirm the current wording during the Gate 0 account audit
(`docs/ops/gate0-checklist.md` §1.2). Platform features change; the spec itself says to re-check before launch (§4).

## 1. Principle

Use a dedicated Google account and a Brand Account YouTube channel. Do not run this project from a personal
daily-use Google account.

Reasons:

- A Brand Account can use a channel name/photo different from the Google account identity.
- Multiple managers can be added later without sharing the primary password.
- It is cleaner for AdSense, channel ownership, and future transfer decisions.

Official reference (not re-verified in T16):

- Manage YouTube channels and Brand Accounts: https://support.google.com/youtube/answer/4642409

## 2. Human-Only Steps

No agent in this repository creates or logs into Google/YouTube accounts, and none is permitted to (spec §9.1
"사람이 처음 한 번 수행해야 하는 일"; `CLAUDE.md` §4). The operator performs these steps directly.

### Step 1: Create Dedicated Google Account

- Create a new Google account for the project.
- Store recovery email and recovery phone securely.
- Enable 2-Step Verification immediately — it is one of the conditions that gate monetization features (spec §8.1).
- Use a password manager.

Naming: the Google account display name is the operator's identity; the public identity belongs to the YouTube
channel / Brand Account.

Official reference (not re-verified in T16):

- Google account creation: https://support.google.com/accounts/

### Step 2: Create YouTube Brand Account Channel

Create a channel with a brand name rather than a personal channel.

**Channel identity is undecided.** The spec lists "크리처 비주얼·브랜드·일반 시청자 포지셔닝" as an open decision to be
made before production assets are produced, on the basis of the Japanese panel test and a rights review (§17). This
document therefore records **no channel name and no handle**. Inventing one here would be a new fact, not an
alignment.

Two constraints the name and the assets must satisfy:

- **Original IP only.** Pokémon names, characters, designs, silhouettes, evolution forms, UI, music and sound
  effects are not used, and "official / affiliated with / inspired by Pokémon" is not used as marketing copy
  (spec §3, §12.1, [S17] [S18]). Every production asset must have provable commercial rights for Live, VOD, ads and
  merchandise, recorded in `ASSETS.md`.
- **Audience classification is not a checkbox.** See Step 6.

Official references (not re-verified in T16):

- Create a YouTube channel: https://support.google.com/youtube/answer/1646861
- Manage Brand Accounts: https://support.google.com/youtube/answer/7001996

### Step 3: Verify YouTube Account

Phone verification is required before live streaming and other features.

Official reference (not re-verified in T16):

- Verify your YouTube account: https://support.google.com/youtube/answer/171664

### Step 4: Request / Unlock Advanced Features

What the spec supports: advanced-features status is one of the items the Gate 0 account audit records, alongside
2-Step Verification, strikes and the AdSense link (spec §8.1).

**확인 필요(출처 없음)** — both of the following were carried over from the pre-spec version of this document and have
no spec source and no verified URL, so they are not asserted here:

- that advanced features are *required* for live streaming and for this product's API usage
- the unlock path itself (phone verification first, then either channel history or ID/video verification)

Read the current requirement from YouTube Studio during the Gate 0 audit and record what it actually says
(`docs/ops/gate0-checklist.md` §1.2). Do not plan the launch around the unverified version.

### Step 5: Enable Live Streaming

YouTube gates live streaming on a verified channel, no live streaming restrictions in the recent period, and the
minimum-age rules. After live streaming is first enabled there may be a waiting period before the first stream, so
account setup happens well before the first launch day.

Official reference: Get started with live streaming — https://support.google.com/youtube/answer/2474026 ([S1])

### Step 6: Decide the Audience Classification (Made for Kids gate)

**A declaration alone does not settle this.** Animated characters and simple games can be treated as
child-directed signals, and a Made for Kids classification removes Live Chat, Super Chat, Gifts and memberships —
that is, the product's core (spec §12.2, [S15] [S29] [S32]).

Before the public pilot, review and keep evidence for all of:

- the actual intended audience, title, thumbnail, language, character presentation
- whether any copy speaks to children or asks them to get a parent to pay
- the share of child-directed content on the channel as a whole
- Japanese local law and YouTube's audience classification
- the audience checklist, the channel audience setting screen, the rights/legal review record, and a named final
  approver

If a general-audience basis cannot be established, this business model is not launched (§12.2). This review is a
Gate 3 precondition (§15).

## 3. Initial Channel Settings

Set these before any public upload.

- Country/region: based on the operator/AdSense reality, not only the target audience.
- Channel audience: the outcome of Step 6 — not a default.
- Language: Japanese, for the Japan-first market (spec §3, §5.3).
- Comments: allowed, with moderation filters.
- Live chat: enabled. The claim that fan-funding features require live chat/comments to stay on carries only the
  URL it was carried over with (**not re-verified in T16**): https://support.google.com/youtube/answer/9277801 —
  confirm it in the Gate 0 audit. Independently of that claim, this product cannot run without live chat: it is the
  only input path (spec §7.2).
- Chat safety defaults: blocked words, URL hold, hold potentially inappropriate messages for review, slow mode
  (spec §12.3, [S16]).
- Branding: profile image, banner, description, links — original assets only (§12.1).
- Description should explain that the stream reacts to live viewer actions, and that all core outcomes are reachable
  through free participation (§8.5 requires paid CTAs to say so).
- Upload category: **확인 필요(출처 없음)** — the spec fixes no category, so this is an operator choice recorded at
  Gate 0 rather than a requirement from this document.

## 4. First Public Content

The pre-spec version of this document listed seven fixed uploads, including a "death and revive" demo. Both the
fixed list and that demo are removed:

- **The creature never dies and never permanently regresses**, and states that only paid revival can clear are
  forbidden (spec §6.3, §8.5). There is nothing to demo.
- **Which public-content path actually produces traffic and YPP-valid metrics is an experiment, not an assumption**
  (§8.2). The candidates the spec names are: rolling archive under 12 hours, human-reviewed original recap/VOD, and
  original Shorts. Bulk uploads of automated templates are not a candidate ([S13] [S14]).

Rules that hold for whatever path is chosen:

- No fabricated participation: no invented usernames, and no system events that look like real viewers, payments or
  chat (§2.6). Demo material must be obviously synthetic.
- No repetitive/generic mass production; automated tooling is fine only if the final content shows creative vision
  and value ([S13]).
- Private/unlisted technical streams are for technical validation, not for growth metrics.

The chosen path and its approval are recorded in the Gate 0 checklist (`docs/ops/gate0-checklist.md` §1.2) and
measured in Gate 4 (`docs/ROADMAP.md`).

## 5. Milestones

These are account-side milestones. They are **not** the product gates — those are Gate 0–5 in `docs/ROADMAP.md`.

### Milestone 1: Live Streaming Ready

- Google account created, 2-Step Verification on
- YouTube Brand Account channel created
- Phone verified
- Advanced features unlocked
- Live streaming enabled
- First private/unlisted technical stream completed

### Milestone 2: Public Launch Ready

- Branding completed with original assets (`ASSETS.md`)
- Audience classification reviewed with evidence (§12.2)
- Technical soak passed: the spec's bar is a 72-hour unattended soak plus one 24-hour public run, with the
  interruption/recovery thresholds approved beforehand (§11, `docs/ops/gate2-experiments.md`)
- Supervisor, alerting and an **off-host dead-man monitor** active (§9.4(8), [S23]) — the host cannot observe its own
  power failure
- Server-authoritative state persistence active (§10.2)
- Approved 24-hour moderation call table (§12.3, `docs/ops/moderation-call-table.md`)

### Milestone 3: Fan-Funding Application Ready

The Expanded YPP application thresholds (spec §8.1, [S8] [S36]):

- 500 subscribers
- 3 valid public uploads in the last 90 days
- 3,000 valid public watch hours in the last 12 months **or** 3 million valid public Shorts views in the last 90 days

These are **application thresholds only**. Monetization-policy compliance, the channel's country, active strikes,
2-Step Verification, advanced features, an AdSense link, channel review and per-feature eligibility all apply
separately, and the actual YouTube Studio state is what the product uses as its feature gate (§8.1).

### Milestone 4: Full YPP (ad revenue sharing)

- 1,000 subscribers
- 4,000 valid public watch hours in the last 12 months **or** 10 million valid public Shorts views in the last
  90 days (§8.1, [S8])

Note two limits the spec draws (§4): watch time from Live that is not converted to VOD does not count toward valid
public watch hours [S8], and there is **no official basis** for counting vertical Live views as valid Shorts views —
so the revenue model counts them as zero [S8].

## 6. Automation Boundary (spec §9.1)

**The human does, once:** create the Google/YouTube account and channel; identity/phone/AdSense verification; accept
terms and the Commerce/Virtual Items modules; approve OAuth and supply the stream key and other secrets; approve
character/music/sound rights; hold the authority to go public and to stop the broadcast.

**The product does, after start-up:** recover the last state; identify the YouTube broadcast and chat and connect the
listener; run the content director and game time; start the renderer and encoder and check them; keep RTMPS running;
process events, logs, metrics, a capacity-limited local rolling archive and off-host availability records; recover
from transient failures and alert; and — if Gate 2 selects it — roll the broadcast over and connect the new
`liveChatId`.

**Outside automation entirely:** account suspensions, strikes, terms changes, re-consent after expiry, and rights
disputes. These trigger an immediate safe stop and a human alert (§9.1); the operational procedure is
`docs/ops/runbook-operations.md` §4.2.
