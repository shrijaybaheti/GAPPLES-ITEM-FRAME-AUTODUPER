# Mineflayer Bot + Local Manager GUI

Local Mineflayer bot with:
- Auto `/login` support (AuthMe-style servers)
- Auto-reconnect on kick/disconnect
- Optional Prismarine Viewer (single-bot mode)
- A local Manager GUI to run multiple usernames in parallel and view logs

This project is meant to run on your machine only. The GUI binds to `127.0.0.1` (localhost).

## Requirements

- Node.js 18+ (Node 20 LTS recommended)
- Windows / macOS / Linux

## Install

```bash
npm install
```

Optional (only needed if you enable Prismarine Viewer):
```bash
npm install canvas
```
If `canvas` fails to install, try Node 20 LTS.

## Run (recommended): Manager GUI (multiple accounts)

Start the local manager:
```bash
npm run gui
```

It prints the URL, usually:
- `http://127.0.0.1:3333`

In the web UI:
1. Set the **password** (used for `/login` for all usernames you run from the manager)
2. Add one or more usernames
3. Run/stop users individually, or “Run all”

Notes:
- Manager spawns `bot.js` once per username and sets env vars like `BOT_USERNAME`/`BOT_PASSWORD`.
- Manager forces `BOT_ENABLE_VIEWER=0` to avoid port conflicts when running many accounts.
- Account list + password are saved locally in `accounts.json`.

## Run: Single bot (one account)

```bash
npm start
```

`bot.js` reads configuration from its local `config` object, but you can override the most important values via env vars:

- `BOT_HOST` (server host)
- `BOT_PORT` (server port)
- `BOT_USERNAME`
- `BOT_PASSWORD`
- `BOT_VERSION` (optional)
- `BOT_AUTH` (optional, e.g. `offline`)
- `BOT_ENABLE_VIEWER` (`1`/`0`)
- `BOT_VIEWER_PORT` (viewer port)

Example (PowerShell):
```powershell
$env:BOT_HOST="play.example.com"
$env:BOT_PORT="25565"
$env:BOT_USERNAME="MyBot"
$env:BOT_PASSWORD="mypassword"
npm start
```

Type `quit` (or `exit`) in the terminal to stop the bot.

## Console commands (in the bot terminal)

- `.help` shows local commands (not sent to Minecraft chat)
- `.placeframe` equips an item frame from inventory and places it on top of the block the bot is standing on

## Publish safely (don’t leak personal info)

Do not publish any real server password, usernames, or personal tokens.

Suggested “safe to commit” set (typical):
- `gui/`
- `manager.js`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `.env.example`
- `accounts.example.json`
- `README.md`

Never commit:
- `.env`
- `accounts.json`
- `node_modules/`
- `bkup/`

Before making this repo public, **open `bot.js` and remove any hardcoded host/username/password** (use env vars or an untracked local config instead).

Quick scan before publishing:
```bash
rg -n "password|username|token|secret|api[_-]?key" -S .
```

## Troubleshooting

- GUI port busy: the manager will auto-try the next ports after `3333`.
- “set password first” in GUI: enter a password in the UI and hit “Save” once.
- Viewer not working: `canvas` is required by Prismarine Viewer at runtime; install it or disable viewer.
