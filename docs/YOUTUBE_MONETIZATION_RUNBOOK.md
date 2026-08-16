# YouTube Monetization Launch Runbook

Last updated: 2026-05-16

This document turns the project from a local prototype into a real YouTube monetization launch plan.

## 1. Operating Goal

Launch a 24/7 unattended vertical live stream that uses a Pokemon-based interactive pet format and monetizes through YouTube fan-funding features first, then ads and memberships when the channel qualifies.

Primary revenue targets:

1. Super Chat
2. Super Stickers
3. Channel memberships
4. Jewels/Gifts, if available for the account and region
5. Ads, after full YPP revenue sharing eligibility

## 2. Account Gate Checklist

These items must be confirmed in the real YouTube account.

- [ ] Dedicated Google account exists.
- [ ] Brand Account YouTube channel exists.
- [ ] Google account has 2-Step Verification enabled.
- [ ] Channel has advanced features access.
- [ ] Channel has no active Community Guidelines strikes.
- [ ] Channel has no live streaming restrictions in the last 90 days.
- [ ] Channel is phone/identity verified for live streaming.
- [ ] AdSense for YouTube is linked or ready to set up in YouTube Studio.
- [ ] Channel audience is not set as Made for Kids.
- [ ] Live chat and comments can be enabled.
- [ ] Channel country/region supports YPP and target fan-funding features.
- [ ] The account owner is at least 18 or has an eligible AdSense arrangement.

## 3. Monetization Thresholds

### Earlier Fan-Funding Access

In eligible countries/regions, the expanded YPP can unlock fan-funding features earlier:

- 500 subscribers
- 3 valid public uploads in the last 90 days
- Either 3,000 valid public watch hours in the last 12 months or 3 million valid public Shorts views in the last 90 days

When accepted at this level, the channel can use eligible fan-funding features such as memberships, Super Chat, Super Stickers, Super Thanks, and potentially Jewels/Gifts if the account meets that feature's requirements.

### Full YPP Revenue Sharing

For ads and broader revenue sharing:

- 1,000 subscribers
- Either 4,000 valid public watch hours in the last 12 months or 10 million valid public Shorts views in the last 90 days

Important: Shorts feed watch hours do not count toward the 4,000 public watch hour threshold.

## 4. Feature Availability Notes

### Super Chat and Super Stickers

Japan and South Korea are listed among available locations for Super Chat and Super Stickers. These features still require the channel to meet fan-funding requirements, accept the relevant commerce terms, and keep live chat/comments enabled.

### Channel Memberships

Memberships require eligibility for fan-funding features and acceptance of the Commerce Product Module. YouTube notes that memberships may be reviewed after YPP acceptance and may not activate instantly.

### Jewels and Gifts

Gifts powered by Jewels are specifically for eligible vertical live streams. Official YouTube Help currently lists availability for eligible creators in the United States and Taiwan. For a Japan-targeted operation, do not treat Gifts as guaranteed until the actual account shows the Gifts option in YouTube Studio Earn.

## 5. Stream Eligibility Rules

To keep fan-funding features available on individual live streams:

- Stream must not be age-restricted.
- Stream must not be unlisted or private.
- Stream must not be Made for Kids.
- Stream must not be attached to a YouTube Giving fundraiser.
- Live chat/comments must not be turned off.
- Gifts require vertical live streams, not horizontal streams.

## 6. Launch Phases

### Phase 0: Create The Account

Goal: create the channel correctly before any uploads or live tests.

- Create dedicated Google account.
- Create a Brand Account YouTube channel.
- Set the channel audience to Not Made for Kids.
- Verify the account by phone.
- Start advanced features unlock.
- Enable live streaming.
- Complete initial branding.

Detailed checklist: `docs/ACCOUNT_SETUP_FROM_ZERO.md`.

### Phase A: Account Audit

Goal: know exactly where the account stands.

User must provide these numbers/statuses manually from YouTube Studio:

- Subscribers
- Public watch hours in the last 12 months
- Shorts views in the last 90 days
- Public uploads in the last 90 days
- Country/region of the channel and AdSense
- YPP status
- Supers status
- Memberships status
- Gifts/Jewels status
- Live streaming restriction status

### Phase B: Technical Pilot

Goal: prove the stream can run without revenue features.

- Run cloud machine with GPU or suitable encoder environment.
- Run `server.py`.
- Run the Vite renderer in broadcast mode.
- Capture `http://127.0.0.1:5173/?mode=broadcast` in OBS.
- Stream privately or unlisted only for technical tests.
- Run a 6-hour soak test.
- Run a 24-hour soak test.
- Confirm restart recovery.

### Phase C: Public Non-Monetized Growth

Goal: build eligibility while keeping policy risk low.

- Publish 3 short public proof-of-liveness videos in 90 days.
- Run daily or continuous public vertical live sessions.
- Show live viewer names/messages in the stream when safe.
- Keep the scene visibly changing through state, weather, evolution, and event logs.
- Avoid static loops.
- Add Japanese title/description once the audience target is finalized.

### Phase D: Fan-Funding Activation

Goal: turn on paid features as soon as the account is eligible.

- Apply for expanded YPP when the channel reaches 500-sub threshold and watch/view requirements.
- Accept Base Terms and Commerce Product Module.
- Link/verify AdSense.
- Enable Super Chat and Super Stickers.
- Enable memberships if surfaced.
- Check if Gifts/Jewels appears in Earn > Supers & gifts.
- Map each paid event into the local event contract.

### Phase E: Monetized 24/7 Operation

Goal: operate as a recurring revenue system.

- Run cloud watchdog.
- Persist game state.
- Persist event/revenue logs.
- Monitor crash/reconnect events.
- Rotate visual events so the broadcast remains dynamic.
- Review daily event conversion by event type.
- Tune pricing-to-effect mapping weekly.

## 7. Immediate Technical Work

Before touching the real account integration, the codebase needs:

1. Persistent game state: SQLite or JSON file.
2. Normalized `/api/log` event schema.
3. Local event replay test script.
4. Cloud startup script.
5. OBS scene setup guide.
6. Watchdog process.
7. YouTube listener integration after account status is known.

## 8. Official References

- YouTube Partner Program overview and eligibility: https://support.google.com/youtube/answer/72851
- Expanded YPP overview: https://support.google.com/youtube/answer/13429240
- Get started with live streaming: https://support.google.com/youtube/answer/2474026
- Super Chat and Super Stickers eligibility: https://support.google.com/youtube/answer/9277801
- Channel memberships: https://support.google.com/youtube/answer/7636690
- Gifts eligibility and availability: https://support.google.com/youtube/answer/15535963
- Turn on gifts: https://support.google.com/youtube/answer/15534883
