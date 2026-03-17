# Mineflayer Login + Chat Bot

This bot:
- Joins a server
- Sends `/login "<password>"` either after spawn or when the server prompts you
- Optional: walks backwards to enter a portal / move off spawn (and does a short post-portal nudge after respawn)
- Optional: hosts Prismarine Viewer at `http://localhost:3007`
- Prints all Minecraft messages to your terminal
- Sends anything you type in the terminal to Minecraft chat
- Auto-reconnects on disconnect/kick

## Setup

1. Install dependencies:
   - `npm install`
2. Optional (Prismarine Viewer): install `canvas` (required by `prismarine-viewer` at runtime):
   - `npm install canvas`
   - If `canvas` fails to install on your Node version, try Node 20 LTS.
3. Edit `bot.js` and set `host`, `port`, `username`, `password` (and optionally `version`/`auth`).
4. Run:
   - `npm start`

Type `quit` (or `exit`) in the terminal to stop the bot.

## Console commands

- `.help` shows local commands (not sent to Minecraft chat)
- `.placeframe` equips an item frame from inventory and places it on top of the block the bot is standing on

## Auto place

If `autoPlaceFrameOnWelcome` is `true` in `bot.js`, the bot will auto-place an item frame after it sees:
`Welcome to gapples.org anarchy server`

If `autoReplaceFrame` is `true`, the bot will keep monitoring the last placed frame location and try to replace it when it disappears/breaks.
