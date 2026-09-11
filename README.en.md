# dsh-qq-onebot-bridge

A bidirectional QQ ↔ DeepSeek Harness bridge plugin (independent bundle). QQ messages drive DSH agent sessions directly, and agent replies are sent back to QQ automatically.

## Feature overview

- **Two-way message bridge**: QQ messages (group/private) enter DSH agent sessions; replies are chunked and sent back to QQ (OneBot v11 reverse WebSocket)
- **Session resume**: the chat → sessionId map is persisted, so after a host restart the bridge resumes the previous session with its full transcript (not just the memory window); only `/new` really starts over
- **Agent-initiated media**: the agent can call `qq_send_image` / `qq_send_file` / `qq_send_voice` / `qq_recall` to push local images, files and voice into the chat, or withdraw its own recent messages (files are restricted to the session cwd plus `fileSendDirs`; credential-shaped paths are always refused)
- **Write-action gate**: every risky OneBot write (ban/kick/notice/essence/card/upload/recall/forward/approvals) shares one rate limiter with per-minute and per-day caps plus an audit log at `cwd/qq-actions.log`
- **Session grouping**: one independent session per group (`sessionMode: chat`) or per sender (`user`); one session per private user, with no context bleed between chats; the agent's system prompt includes the current chat scope
- **Persistent memory**: each chat's recent conversation is saved to `cwd/qq-memory/` and re-injected into new sessions after host restarts, so the bot remembers previous chats (`memoryEnabled` switch; `/new` clears the memory for that chat)
- **Scheduled reminders**: "提醒我 30 分钟后喝水" / "明天9点开会" — the bot pings the chat at the set time (groups require @-mentioning the bot; private chats work directly; reminders survive host restarts, `/reminders` lists them)
- **Group management suite**: `/summary` summarizes recent chat; group votes ("投票：question? A opt B opt", members reply with option letters); shared todos (`/todo` + "记一下：xxx"); admin commands `/mute` `/unmute` `/kick` (**kick requires a second confirmation**) `/clear` (only `adminUsers`)
- **Voice replies (TTS)**: an optional voice message follows each text reply — cloud (Azure Xiaoxiao by default; `ttsProvider` can switch to any OpenAI-compatible service) or **local GPT-SoVITS voice cloning** (`ttsProvider: local`, zero API cost, clones a voice from a 3-10s reference clip); `ttsEnabled` is off by default
- **Avoid peak hours**: no replies at all on weekdays 9:00-12:00 and 14:00-18:00 (`quietHoursEnabled` is off by default, windows editable, weekends exempt; already-scheduled reminders/vote publishing still fire)
- **Interactions**: `/help` command menu; poke cute-replies (`pokeEnabled`); voice reading (quote text saying "读一下" or `/读 <text>` → TTS read-aloud); daily check-in (`checkinEnabled` off by default); new-member auto welcome (`welcomeEnabled` off by default)
- **Image generation**: `/画 <prompt>` generates an image and sends it back (`imageGenEnabled` off by default, groups require @; `imageGenProvider: openai` for any OpenAI-compatible `/images/generations`, or `local` for a local Stable Diffusion WebUI — extensible, one branch per backend)
- **Group insight and daily report**: `statsEnabled` message statistics (`/统计` today, `/周榜` this week); read-only `/荣誉` `/公告` `/群精华`; `dailyReportEnabled` posts an agent-written daily summary at a fixed time; `/mc <address>` pings a Minecraft server; `recurringReminderEnabled` supports "每天8点", "每周一9点" and "每个工作日15点"
- **Anti-recall and group rules**: `antiRecallEnabled` reposts withdrawn messages (images included); `filterEnabled` sensitive-word filtering (warn / recall / mute, hot-reloaded word list); `floodEnabled` anti-flood warnings and escalation; group/friend join verification (`verifyEnabled` with admin `/同意 <id>` approval, passphrase or correct-answer auto-approval)
- **Group management suite**: `/mute` `/unmute` `/kick` `/clear` plus `/公告` `/精华` `/名片` `/头衔` `/全员禁言` — all funnelled through the shared write-action gate
- **Zero-cost interaction pack**: keyword wordbook (`/kw add`, instant replies with zero tokens), 今日人品/运势/抽签/塔罗 (deterministic per QQ id + day), dice and random picks, a points economy (earn by chatting/check-in, `/转账` to transfer) and mini-games (idiom chain with a 373-idiom dictionary, guess-the-number) — all computed locally, no model call
- **Utility tools**: `/health` runtime diagnostics, private file auto-save to the local machine, `/export` chat history to markdown
- **Speech-to-text (STT)**: in groups, @-mention the bot while quoting (replying to) a voice message → transcribe and reply with the text; private voice messages are transcribed directly. Works with Zhipu GLM-ASR-2512 or any OpenAI-compatible `/audio/transcriptions` endpoint (e.g. SiliconFlow)
- **Private image viewing**: images/animated stickers sent in private chats are downloaded to `cwd/qq-images/` and injected into the session so the agent can view them with `describe_image` and respond (`privateImageView` switch)
- **Quote resolution**: quoting text/images/voice while @-mentioning the bot expands them automatically (images saved under `cwd/qq-replies/` for `describe_image`; voices transcribed)
- **Face system**: yellow-face table + `[face:name]` markers in replies + image sticker collection (`autoCollectStickers`) + per-session `qq_face_list` / `qq_face_send` tools (master switch `faceEnabled`)
- **Session commands**: `/new` resets the current session, `/status` shows session state
- **Safety controls**: `allowUsers` / `allowGroups` allowlists, `accessToken` auth, `replyOnlyWhenMentioned` for groups
- **Persona decoupled**: the plugin contains **no persona or memory content** — personas and group rules are injected into sessions via dsh-mnemon's `USER.md`/`MEMORY.md` (see below)

## Architecture

```
QQ client ←→ OneBot implementation (NapCat / LLOneBot / OpenShamrock / Lagrange…)
                │ reverse WebSocket (the OneBot side connects to us)
                ▼
      dsh-qq-onebot-bridge (this plugin)
                │ ctx.agents.create / followup
                ▼
      DSH agent sessions (one per group / per private user)
```

## Install / uninstall

```sh
# install (local directory)
dsh plugin --profile web add <this-directory>

# uninstall anytime (independent bundle, does not affect other plugins)
dsh plugin --profile web remove dsh-qq-onebot-bridge
```

Restart `dsh web` after install/uninstall.

## Configuration

Override `id: dsh-qq-onebot-bridge` config in the profile's `cordis.patch.yml` (full example in `examples/cordis.patch.example.yml`):

| Key | Default | Description |
|---|---|---|
| `host` | `127.0.0.1` | Reverse-WS listen host |
| `port` | `6700` | Reverse-WS listen port |
| `accessToken` | `''` | Bearer token the OneBot client must present (empty = no check) |
| `allowUsers` | `[]` | Private-chat user allowlist (**empty = deny all private chats**; list your own QQ id) |
| `allowGroups` | `[]` | Group allowlist (**empty = deny all group messages**; list the groups the bot serves) |
| `botQq` | `0` | Bot QQ id used for @-mention detection in groups (0 = treat every group message as mentioned) |
| `replyOnlyWhenMentioned` | `true` | In groups, only respond when the bot is @-mentioned |
| `acceptPrivate` | `true` | Whether to respond to private chats (private chats still require allowUsers allowlisting) |
| `autoCollectStickers` | `false` | Auto-save image stickers from messages into the local library |
| `faceEnabled` | `true` | Master switch for emoji features ([face:] markers and qq_face_* tools) |
| `sessionMode` | `chat` | Group session mapping: `chat` = one session per group, `user` = one per sender |
| `cwd` | `''` | Working directory (also determines `qq-faces/`, `qq-images/`, `qq-replies/`, and the debug log location) |
| `provider` | `''` | LLM provider override (empty = agent default) |
| `model` | `''` | LLM model override (empty = agent default) |
| `maxMessageLength` | `1700` | Max chars per outbound QQ message before chunking |
| `botName` | `小鲸鱼` | Bot display name used in merged-forward cards |
| `sessionResumeEnabled` | `true` | Resume the chat's previous session after a host restart (full transcript); `false` = always start a new session |
| `agentMediaToolsEnabled` | `true` | Expose the `qq_send_image` / `qq_send_file` / `qq_send_voice` / `qq_recall` tools |
| `fileSendDirs` | `[]` | Extra directories the agent may send files from (the session cwd is always allowed) |
| `fileSendMaxBytes` | `52428800` | Max size of a file the agent may send (bytes, default 50 MiB) |
| `imageSendMaxBytes` | `4194304` | Images larger than this (default 4 MiB) are compressed with ffmpeg before sending |
| `recallWindowSeconds` | `110` | How long an outbound message stays withdrawable via `qq_recall` / `/撤回` |
| `forwardLongReplies` | `false` | Deliver long group replies as a merged-forward card |
| `forwardThresholdChars` | `600` | Character count from which a group reply becomes a merged-forward card |
| `actionRatePerMinute` | `20` | Write-action gate: max OneBot write actions per minute across all chats |
| `actionRatePerDay` | `500` | Write-action gate: max OneBot write actions per day across all chats |
| `actionAuditEnabled` | `true` | Append every write action and denial to `cwd/qq-actions.log` |
| `keywordEnabled` | `false` | Keyword wordbook (default OFF): matching messages are answered from a local JSON file without calling the model or requiring an @-mention |
| `keywordFile` | `''` | Wordbook path (empty = `cwd/qq-keywords.json`); exact/contains/regex triggers, random reply pools, images, scopes and cooldowns |
| `fortuneEnabled` | `true` | Local fortune features: 今日人品/运势, 抽签, 塔罗 (deterministic per QQ id + day) |
| `diceEnabled` | `true` | Dice (`.r 3d6`) and random picks (`/抽一个 A B C`) |
| `pointsEnabled` | `false` | Points economy (default OFF): `/积分`, `/排行榜`, `/转账 @user amount` |
| `pointsPerMessage` | `1` | Points earned per chat message (0 = chatting earns nothing) |
| `pointsDailyCap` | `20` | Max points a member can earn from chatting per day |
| `pointsCheckinBonus` | `5` | Extra points for the daily check-in |
| `gameEnabled` | `false` | Chat mini-games (default OFF): idiom chain and guess-the-number |
| `idiomChainTimeoutSeconds` | `120` | Idle timeout of an idiom-chain round |
| `guessNumberMax` | `100` | Upper bound of guess-the-number |
| `guessNumberMaxTries` | `10` | Allowed guesses in guess-the-number |
| `antiRecallEnabled` | `false` | Anti-recall (default OFF): cached messages are reposted when withdrawn |
| `antiRecallInGroup` | `true` | Post into the group (`false` = private message to the first admin) |
| `antiRecallImages` | `true` | Re-send withdrawn images (up to 3) |
| `antiRecallCacheSize` | `50` | Messages cached per chat |
| `antiRecallMaxAgeMinutes` | `120` | How long a cached message stays recoverable |
| `antiRecallCooldownSeconds` | `5` | Min seconds between two anti-recall posts in one chat |
| `filterEnabled` | `false` | Sensitive-word filter (default OFF) |
| `filterWordsFile` | `''` | Word list path (empty = `cwd/qq-badwords.txt`; `#` comments, `re:` regex, hot reload) |
| `filterAction` | `warn` | Reaction: `warn` / `recall` / `mute` |
| `filterMuteSeconds` | `300` | Mute duration for `mute` and flood escalation |
| `filterWhitelist` | `[]` | Always-allowed words/patterns |
| `floodEnabled` | `false` | Anti-flood (default OFF) |
| `floodWindowSeconds` | `10` | Flood detection window |
| `floodMaxMessages` | `8` | Messages allowed per window |
| `floodMuteSeconds` | `300` | Mute duration when the flood guard escalates |
| `floodStrikeLimit` | `3` | Warnings before a flood mute |
| `verifyEnabled` | `false` | Join/friend verification (default OFF): requests are queued and pushed to admins |
| `verifyKeyword` | `''` | Passphrase that auto-approves a request (empty = always human approval) |
| `verifyTimeoutSeconds` | `300` | Request expiry before it leaves the queue and admins are reminded |
| `verifyMaxPending` | `20` | Max queued requests |
| `statsEnabled` | `false` | Message statistics (default OFF): `/统计` today, `/周榜` this week; also feeds the daily report |
| `statsKeepDays` | `30` | Days of per-member counts kept |
| `groupReadEnabled` | `true` | Read-only group queries: `/荣誉` `/公告` `/群精华` |
| `mcStatusEnabled` | `true` | `/mc <host[:port]>` Minecraft Java status via Server List Ping (no key) |
| `mcStatusTimeoutMs` | `5000` | Minecraft status ping timeout |
| `recurringReminderEnabled` | `true` | Recurring reminders ("每天8点", "每周一9点", "每个工作日15点") |
| `dailyReportEnabled` | `false` | Daily group report (default OFF): the agent summarizes the day at `dailyReportTime` |
| `dailyReportTime` | `22:00` | Local time (HH:mm) of the daily report |
| `dailyReportChats` | `[]` | Chats that always receive the report (e.g. `["g:100000001"]`; empty = chats that ran `/日报 on`, then all allowlisted groups) |
| `sttEnabled` | `false` | Speech-to-text master switch |
| `sttBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | STT endpoint (OpenAI-compatible `/audio/transcriptions`) |
| `sttModel` | `glm-asr-2512` | STT model (Zhipu `glm-asr-2512` / SiliconFlow `FunAudioLLM/SenseVoiceSmall`) |
| `sttApiKey` | `''` | STT API key (can reuse a Zhipu GLM key) |
| `privateImageView` | `true` | In private chats, proactively download and view images/animated stickers the user sends (saved to `cwd/qq-images/`, viewed with describe_image) |
| `visionMode` | `tool` | Image viewing mode: `tool` = save to disk and view via `visionToolName` (stable); `native` = attach images as native multimodal attachments (DSH 0.1.1+, text-only models degrade automatically) |
| `visionToolName` | `describe_image` | Vision tool used in `tool` mode |
| `memoryEnabled` | `true` | Per-chat persistent memory (recent conversation saved to `cwd/qq-memory/`, restored after host restarts; `/new` clears it) |
| `memoryMaxEntries` | `30` | Max conversation lines kept per chat |
| `rateLimitEnabled` | `false` | Outbound reply rate limiting (off by default); when on, each chat gets at most `rateLimitMaxReplies` replies per window |
| `rateLimitMaxReplies` | `10` | Max replies per chat per window |
| `rateLimitWindowSeconds` | `60` | Rate limit sliding window (seconds) |
| `dedupEnabled` | `true` | Ignore duplicate inbound message ids within the window (reconnect re-delivery) |
| `dedupWindowSeconds` | `300` | Dedup window (seconds) |
| `reminderEnabled` | `true` | Scheduled reminders (groups require @-mention; private chats work directly; persisted in `cwd/qq-reminders.json` across restarts) |
| `reminderMaxPerChat` | `10` | Max pending reminders per chat |
| `quietHoursEnabled` | `false` | Avoid-peak-hours switch (**off by default**); while on, the bot replies to no inbound message during the quiet windows on weekdays (no model calls consumed); scheduled reminders and vote publishing still fire |
| `quietHours` | `['9:00-12:00', '14:00-18:00']` | Quiet windows as local-time `H:MM-H:MM` ranges (full-width colons are normalized; overnight ranges like `22:00-2:00` work) |
| `quietWeekendExempt` | `true` | Saturdays and Sundays are not subject to quiet hours |
| `ttsEnabled` | `false` | Voice-reply master switch (off by default; when on, a voice message follows each text reply) |
| `ttsProvider` | `azure` | Synthesis backend: `azure` (Microsoft Xiaoxiao) / `openai` (any OpenAI-compatible `/audio/speech`) / `local` (**local GPT-SoVITS voice cloning, zero API cost**) |
| `ttsApiKey` | `''` | Azure / OpenAI-compatible API key (not needed for `local`) |
| `ttsVoice` | `zh-CN-XiaoxiaoNeural` | Cloud voice id |
| `ttsStyle` | `chat` | Azure speaking style (cheerful/sad…) |
| `ttsMaxChars` | `120` | Max chars spoken per voice reply (truncation affects voice only) |
| `ttsLocalUrl` | `http://127.0.0.1:9880` | Local GPT-SoVITS api_v2 server URL |
| `ttsLocalRefAudio` | `''` | **Required for local TTS**: absolute path to the reference voice clip (3-10s wav, e.g. `D:/voice/xiaojingyu.wav`) |
| `ttsLocalPromptText` | `''` | Transcript of the reference clip (may be empty) |
| `ttsLocalTextLang` | `zh` | Language of the text to synthesize |
| `ttsLocalPromptLang` | `zh` | Language of the reference clip transcript |
| `ttsLocalConvertToMp3` | `true` | Auto-convert local wav output to mp3 with ffmpeg before sending (better QQ/NapCat compatibility) |
| `pokeEnabled` | `true` | Poke replies: a random cute line when someone pokes the bot (allowlisted chats only) |
| `pokeReplies` | `[...]` | Poke reply lines (one is picked randomly) |
| `pokeCooldownSeconds` | `15` | Min seconds between poke replies per chat (anti-spam) |
| `voiceReadingEnabled` | `true` | Voice reading: @bot + quote text saying "读一下/念出来", or `/读 <text>` (synthesized via ttsProvider) |
| `checkinEnabled` | `false` | Daily check-in (**off by default**): say the keyword (default 签到) to check in; streaks persisted per chat in `cwd/qq-checkin/`; 签到榜 shows the leaderboard |
| `checkinKeyword` | `签到` | Check-in trigger keyword |
| `welcomeEnabled` | `false` | New-member welcome (**off by default**): @-mention the newcomer with the welcome text when someone joins (bot itself excluded) |
| `welcomeText` | `''` | Welcome text (empty = built-in default) |
| `imageGenEnabled` | `false` | Image generation switch (**off by default**): `/画 <prompt>` generates an image (groups require @-mentioning the bot) |
| `imageGenProvider` | `openai` | Backend: `openai` = any OpenAI-compatible `/images/generations` (DALL·E/CogView/SiliconFlow…); `local` = local SD WebUI (AUTOMATIC1111) |
| `imageGenBaseUrl` | `''` | Backend base URL (empty = provider default: api.openai.com or 127.0.0.1:7860) |
| `imageGenApiKey` | `''` | API key for OpenAI-compatible providers (not needed for local) |
| `imageGenModel` | `''` | Model id (empty = provider default, e.g. gpt-image-1; ignored by local) |
| `imageGenSize` | `1024x1024` | Image size WxH (local supports arbitrary sizes like 768x512) |
| `imageGenSteps` | `20` | Sampling steps (local only) |
| `imageGenCfgScale` | `7` | CFG scale (local only) |
| `imageGenSampler` | `''` | Sampler (local only; empty = WebUI default) |
| `imageGenCooldownSeconds` | `60` | Min seconds between generations per chat (cost/spam guard) |
| `imageGenDailyLimit` | `20` | Max generations per chat per day |
| `imageGenMaxPromptChars` | `400` | Max prompt characters (truncated beyond) |
| `imageGenCommand` | `/画` | Trigger command for image generation |

## OneBot side setup

With NapCat, set the WebSocket client URL in the OneBot11 config to:

```
ws://127.0.0.1:6700/
```

Other implementations work the same way (LLOneBot: reverse WebSocket; OpenShamrock: passive WebSocket; go-cqhttp: `ws-reverse`). If `accessToken` is set, use the same token on the OneBot side.

## Speech-to-text (STT)

**Trigger rules** (final):

| Scenario | Behavior |
|---|---|
| Group: @-mention the bot + quote (reply to) a voice message | ✅ Transcribe the quoted voice and reply with text |
| Group: plain voice message (no @ / no quote) | ❌ No trigger |
| Private: direct voice message | ✅ Transcribe and reply (independent of `acceptPrivate`) |
| Private: text + quoted voice | ✅ Transcribe the quoted voice |

Pipeline: the quoted message → `get_msg` → contains a `record` segment → OneBot `get_record` (`out_format` mp3/wav, response contains `base64`) → POST `{sttBaseUrl}/audio/transcriptions` (multipart field **`file`**, binary) → transcription injected into the session.

Notes:
- Zhipu GLM-ASR-2512 accepts wav/mp3, **≤ 30 s**, ≤ 25 MB; use SiliconFlow or another endpoint for longer audio
- The Zhipu endpoint requires the multipart field `file` (binary) — the documented `file_base64` field is rejected at runtime with error 1214

## Session grouping

- Groups: with `sessionMode: chat` (default), each group has one session shared by all members; with `user`, one session per sender
- Private chats: one session per user, fully isolated from groups
- The agent's system prompt includes the chat scope ("You are chatting in QQ group xxx" / "You are in a private QQ chat with user xxx") and is told not to mix up context between chats
- `/new` resets only the **current** session; sessions live in memory and are rebuilt after a host restart (not persisted)

## Face system

- `[face:鼓掌]`-style markers in replies are expanded into CQ face segments (see the yellow-face table in `lib/faces.js`, ~70 entries)
- With `faceEnabled=true`, each session registers `qq_face_list` / `qq_face_send` tools
- Dropping image files into `cwd/qq-faces/` registers them as sendable stickers automatically (file name = sticker name); deleting a file removes it
- With `autoCollectStickers=true`, image stickers from incoming messages are collected automatically

## Commands & debugging

- `/new`: end the current session and start a fresh one
- `/status`: show the current session state and session id prefix
- Debug log: `{cwd}/qq-bridge-debug.log` (message routing, voice transcription, agent events, timestamped)
- Host error log: redirect stderr when starting `dsh web` (e.g. `D:\qq-work\qq-host-err.log`) to diagnose startup crashes
- Key log markers: `voice fetched via get_record`, `quoted voice transcribed`, `followup sent (voice)`, `group msg without @bot ignored`

## Tests

`test/` contains WebSocket protocol simulation scripts (they impersonate the OneBot side and assert send/receive):

- `protocol-smoke.mjs` protocol smoke test; `sim-group.mjs` / `sim-private.mjs` group/private; `sim-user.mjs` per-user sessions
- `sim-quote.mjs` quote resolution; `sim-face.mjs` / `sim-sticker*.mjs` face pipeline; `live-status.mjs` live status

Run with the host up: `node test/sim-group.mjs`. The STT path is best tested with a real QQ voice message (simulated scripts require a real STT call).

## Persona & memory (important)

This plugin ships **no persona, preferences, or group rules**. The whale-girl persona, Q&A preferences, and group behavior rules are injected into every QQ session by the **dsh-mnemon** plugin's runtime memory (`~/.mnemon/runtime/USER.md` + `MEMORY.md`) — the plugin provides the *functionality*, memory provides the *personality*, and the two are fully decoupled. Change the persona by editing Mnemon memory; change behavior by editing this plugin.

## ⚠️ Risks & compliance (read before use)

### Account risk control
- This plugin connects to QQ through **third-party protocol implementations** (NapCat etc.), which are **not official Tencent APIs** and conflict with the QQ license agreement; Tencent explicitly bans unofficial clients/protocols
- Using third-party protocols carries the risk of **login restrictions, freezes, or permanent bans**, and may affect other QQ accounts on the same device/IP
- Use a **dedicated bot account** — never your main account
- Common risk triggers: high-frequency messaging, mass messaging in short periods, marketing/advertising/violating content, reports from other users, unusual login devices
- Mitigations: lower reply frequency, run only in small/private groups, avoid 24/7 spamming, keep content compliant

### Content compliance
- Everything the agent generates is sent under the bot account — **you are responsible for everything published by that account**
- Constrain outputs in the persona/system prompt; violating content triggers account penalties and possibly legal liability

### Security
- With `allowUsers` / `allowGroups` unset (empty), the plugin **denies all private and group messages by default** — explicitly list your own QQ id and the groups to serve before use; once configured, nobody outside the allowlists can drive your agent
- The plugin listens on `127.0.0.1` only; do not change it to `0.0.0.0`
- Voice and images are uploaded to third-party cloud services (STT API) — **do not send sensitive audio**

### Compliance tips
- For personal learning and small internal groups only; do not use for mass marketing, advertising, harassment, or bot-farming
- Comply with local laws and Tencent platform rules
- Using third-party protocols is **at your own risk**; this plugin offers no ban-free guarantee

### Disclaimer
This plugin is provided for technical learning and personal research. Users must assess and bear all risks and consequences of using third-party QQ protocols themselves.

## Security notes

- With `allowUsers` / `allowGroups` empty, all messages are denied by default — list your own QQ id and groups before use
- The port listens on 127.0.0.1 only; do not expose it
- OneBot implementations themselves carry QQ ban risk; assess third-party bot protocols yourself

## Changelog

The five most recent versions (always kept rolling):

- **v0.3.9** — group insight: message statistics (`/统计` `/周榜`), read-only `/荣誉` `/公告` `/群精华`, a daily group report (off by default), recurring reminders (daily/weekly/weekdays) and `/mc` Minecraft status
- **v0.3.8** — anti-recall, sensitive-word and flood protection, group/friend join verification (admin `/同意 <id>`), a wider group-admin API (`/公告` `/精华` `/名片` `/头衔` `/全员禁言`) and all admin writes moved behind the shared gate
- **v0.3.7** — zero-cost interaction pack: keyword wordbook (off by default), local fortune/lot/tarot, dice and random picks, points economy (off by default), idiom chain (373 idioms) and guess-the-number (off by default); fixes the `stop()` disposer and the idiom-chain rule
- **v0.3.6** — agent-initiated actions and session resume: `qq_send_image/qq_send_file/qq_send_voice/qq_recall` tools, resuming the full session after a host restart, merged-forward cards for long replies, a shared write-action gate (rate limits + audit log), and `/撤回`
- **v0.3.5** — image generation (off by default): `/画 <prompt>` generates an image; `imageGenProvider` supports any OpenAI-compatible service or a local SD WebUI — two extensible backends

Full history in [CHANGELOG.md](CHANGELOG.md).
