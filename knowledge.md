# Ladybug Cloud knowledge base

Ladybug Cloud (https://ladybugcloud.xubi.org) is WhatsApp bot hosting by Ntandomods. It hosts and keeps online the "Ladybug Mini" WhatsApp bot for users, so they need no Node, terminal or config files. The site has these pages: Pricing (#/pricing), Status (#/status), Log in (#/login), Register (#/register), Dashboard (#/dashboard), Pay (#/pay), Support / Contact admin (#/support), Settings (#/settings), Storage (#/storage).

## Getting started (3 steps, about 2 minutes)
1. Get a session: in the dashboard create a bot, enter your WhatsApp phone number with country code, press "Get code". An 8-digit pairing code is shown (valid about 60 seconds). On your phone open WhatsApp > Linked devices > Link with phone number and type the code. Alternatively paste an existing session ID (it starts with "Ladybug!").
2. Press Start on your bot.
3. Stay online: keep coins or a subscription so the bot keeps running.
Each account gets one bot by default. Pairing happens in the browser, nothing to install.

## Free trial
7 days free, no card required, one bot, live logs, auto-restart, browser pairing.

## Daily coins
- After the trial, hosting one bot costs 20 coins per day.
- You can claim 20 free coins every 24 hours from the dashboard (button "Claim 20 free coins"). That exactly covers one bot for a day.
- The free balance holds up to 140 coins (one week). Bought coins are not limited by that cap, never expire, and are spent only after the free daily coins run out.
- If the balance cannot cover the next day the bot PAUSES. Nothing is deleted: settings and session stay saved. Claim coins and press Start to bring it back.

## Paid options (USD per 30 days unless noted)
- Unlimited: $3/month. Bot runs 24/7 without spending coins; no daily claiming; coins stay in the balance.
- Auto-claim: $2/month. The server claims the 20 daily coins for you every 24h so you never lose the bot to a forgotten claim. Pointless if you already have Unlimited.
- Extra bot slot: $1/month each. Adds one more bot; stackable, works on any plan including the trial. It simply expires if you stop paying.
- Custom bot settings (env vars): $1/month.
- Crash alerts (webhook): $1/month. Account settings let you set an alert webhook and send a test alert.
- Uptime history (30 days): $1/month.
- Coin packs (never expire): 100 coins for $1 (about 5 days of hosting), 300 coins for $2.50.
Prices are also shown in ZiG (Zimbabwe Gold); the live rate is provided in the LIVE DATA block when available. Always prefer the live numbers over these if they differ.

## How to pay
Payments are by bank transfer in USD or ZiG to the NSB bank accounts listed on the Pay page (#/pay) once signed in. After paying, submit the payment request on the Pay page (include the bank receipt/reference number) and/or message the admin from the dashboard with proof of payment. When the admin confirms, the account switches to the purchased plan. Confirmation is manual, so it is not instant; if it takes long, contact the admin via #/support. Never invent bank account numbers; tell the user to open the Pay page.

## Referrals
Share your personal referral link from the dashboard. The friend gets 20 bonus coins at sign-up; you get 40 bonus coins once their bot has been online for 10 minutes. Up to 10 rewards per month. Bonus coins never expire. Self-referral with a second account does not count.

## What Ladybug Mini can do (command categories, default prefix ".")
- Owner (14+ cmds): .autostatus .savestatus .autoread .antidelete .setprefix .broadcast and more.
- Admin (14+ cmds): .antilink .antispam .antibot .welcome .tagall .warn and more.
- Downloader (10+ cmds): .play .ytmp4 .tiktok .instagram .facebook .lyrics and more.
- General (14+ cmds): .ai .sticker .vv .viewonce .textmaker .translate and more.
The prefix can be changed with .setprefix.

## Features of the dashboard
Start/stop the bot, live logs, auto-restart setting, live memory and CPU on each bot card, file Storage page, uptime history (add-on), crash alerts (add-on), password change in Settings, public Status page showing platform uptime and bot names (session IDs are never shown publicly).

## Safety and privacy
The bot runs as a linked device like WhatsApp Web. Chats stay on WhatsApp. Session IDs are private. Users must follow WhatsApp rules: no spamming groups or blasting random numbers (risk of ban). Accounts, bots, coins and logins are backed up continuously and restored automatically if the site restarts.

## Troubleshooting
- Bot not responding: check the dashboard for its status. If paused, claim coins and press Start. If running but silent, check the live logs, confirm you use the right prefix (default "."), and check that the WhatsApp linked device still exists on the phone (Linked devices).
- Pairing code does not work: it expires in about 60 seconds; request a new one. Use the full number with country code, no plus sign or spaces issues. Make sure WhatsApp is updated and you chose "Link with phone number".
- Logged out / session invalid: the session was removed from WhatsApp Linked devices or the account was logged out. Pair again to get a new session and update the bot.
- Cannot claim coins: the claim is available once every 24h; the button shows a countdown.
- Bot keeps restarting or crashes: view the logs; enable auto-restart; consider crash alerts; send the log lines to the admin.
- Forgot password / account problems: contact the admin via #/support (there is no email reset described on the site).
- Payment not confirmed: confirm the proof was sent through the Pay page or dashboard messages; wait for admin confirmation; escalate via #/support.
- WhatsApp banned the number: this is WhatsApp's decision, Ladybug Cloud cannot lift it. Advise following the rules.

## Escalation
For anything the assistant cannot resolve (payments to confirm, refunds, account recovery, bans, bugs), tell the user to log in and use "Contact admin" at #/support (messages go to the admin, Ntandomods). Never promise refunds, deadlines, or approvals.
