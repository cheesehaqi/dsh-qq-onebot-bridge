# dsh-qq-onebot-bridge

A bidirectional QQ ↔ DeepSeek Harness bridge plugin (independent bundle). QQ messages drive DSH agent sessions directly, and agent replies are sent back to QQ automatically.

## Feature overview

- **Two-way message bridge**: QQ messages (group/private) enter DSH agent sessions; replies are chunked and sent back to QQ (OneBot v11 reverse WebSocket)
- **Session grouping**: one independent session per group (`sessionMode: chat`) or per sender (`user`); one session per private user, with no context bleed between chats; the agent's system prompt includes the current chat scope
- **Persistent memory**: each chat's recent conversation is saved to `cwd/qq-memory/` and re-injected into new sessions after host restarts, so the bot remembers previous chats (`memoryEnabled` switch; `/new` clears the memory for that chat)
- **Scheduled reminders**: "提醒我 30 分钟后喝水" / "明天9点开会" — the bot pings the chat at the set time (groups require @-mentioning the bot; private chats work directly; reminders survive host restarts, `/reminders` lists them)
- **Group management suite**: `/summary` summarizes recent chat; group votes ("投票：question? A opt B opt", members reply with option letters); shared todos (`/todo` + "记一下：xxx"); admin commands `/mute` `/unmute` `/kick` (**kick requires a second confirmation**) `/clear` (only `adminUsers`)
- **Voice replies (TTS)**: an optional voice message follows each text reply (Azure Xiaoxiao by default; `ttsProvider` can switch to any OpenAI-compatible service; `ttsEnabled` is off by default)
- **Avoid peak hours**: no replies at all on weekdays 9:00-12:00 and 14:00-18:00 (`quietHoursEnabled` is off by default, windows editable, weekends exempt; already-scheduled reminders/vote publishing still fire)
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
- Host error log: redirect stderr when starting `dsh web` (e.g. `D:\Deepseek\qq-host-err.log`) to diagnose startup crashes
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

- **v0.3.2** — avoid-peak-hours silence (off by default): weekdays 9:00-12:00 / 14:00-18:00 the bot replies to nothing, weekends exempt, windows configurable
- **v0.3.1** — online/offline status push (off by default, supports PushPlus/custom webhook) + GIF frame extraction for image understanding (on by default, uses ffmpeg automatically)
- **v0.3.0** — voice replies TTS (Azure Xiaoxiao by default, swappable to any OpenAI-compatible service) + `/health` diagnostics, private file transfer, `/export` chat history
- **v0.2.9** — group management suite: `/summary` chat summary, group votes, shared todos (`/todo`), admin commands `/mute` `/unmute` `/kick` (kick needs a second confirmation) `/clear`
- **v0.2.8** — opt-in reply rate limiting + inbound message dedup

Full history in [CHANGELOG.md](CHANGELOG.md).
