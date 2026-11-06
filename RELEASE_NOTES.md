# Game Pager v1.0.0

First public release of Game Pager: a retro-style pager for two friends to sort out game nights.

## Self-hosted, by design

Game Pager is **not a hosted service**. There's nothing to sign up for and no shared server. You deploy your own copy to **your own free Cloudflare account**, and it runs at your own address. Your names, statuses and notification subscriptions stay in your account, and nobody else, including the project author, can access them.

One person does the setup on a computer (about 15 minutes, steps in the [README](README.md)), then sends the link and pair code to their friend.

## Features

- **Page your friend:** "You on tonight?" with a one-tap **In / Maybe / Out** answer.
- **I'm on at:** quick-pick times (7:00–9:00 PM by default, editable) plus a custom time.
- **Running late:** +10, +15 or +30 minutes, with an updated time.
- **Hopping on NOW:** an instant alert when you launch the game.
- **Your own names:** each person types their own name when pairing; nothing is pre-filled.
- **Your own pair code:** you choose it during setup and can change it any time.
- **Push notifications:** Android (Chrome) and iPhone (home-screen app, iOS 16.4+), with no Firebase account needed.
- **Optional PUBG stats:** add a free PUBG API key and your Steam PUBG names to get last session's games, wins, kills and top 10s every morning.
- **Three looks:** Retro pager, Military and Minimal, picked per phone under **Settings → Look**.
- **Try it locally first:** `npm run setup:local` + `npm run dev` runs the whole pager on your computer before you deploy.
- **Settings:** rename yourself, send a test alert, unpair a phone, or reset the pager.
- **"Tonight" resets at 5 AM** in your chosen time zone.

## Requirements

- Free Cloudflare account (Workers free plan)
- Node.js LTS for the one-time setup
- Optional: PUBG API key from developer.pubg.com

## Known limits

- Exactly two people per pager. To pair a different group, deploy another copy under a different name.
- iPhone alerts only work when the app is opened from the home screen.
- PUBG stats cover the Steam platform, and the PUBG API keeps about 14 days of match history.
