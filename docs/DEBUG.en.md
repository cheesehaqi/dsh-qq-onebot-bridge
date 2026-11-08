# Debugging (trace · replay · diagnostics · injection)

> Moved out of the README (which got too long). This page is for digging into **why one specific message got no reply**; if you only want it running, the [README](../README.en.md) is enough.
> Every console entry below lives in `control/` (default `127.0.0.1:8799`); the panel's "控制台（独立进程）" link starts it for you.

Every inbound message gets a **trace id**, and every decision point — **including every silent drop** — records `stage + ok + reason + duration`. That is the design philosophy of this release: when something goes wrong you should never have to guess.

| What you want to know | Where to look |
|---|---|
| **Are the 6 hard constraints met right now?** | Console → "**硬约束验收台**" at the top: 6 status lights, the evidence currently on the machine, and where to click next; recomputed every 30s |
| The full decision chain of one message | Console → "实时事件流": click any row, the "决策链" card shows the timeline, where it stopped and why |
| Why the bot did not reply | Filter the event stream to failures — the most common reasons are listed (e.g. `mention: 群聊未 @ 机器人`) |
| Port ownership and liveness | Console → "端口 / 进程" (connections on 6700 = bot online) |
| One-click triage | Console → "一键体检": 15-19 pass/fail checks with fix hints (paths, ports, link, snapshot, errors, gate denials…) |
| Effective config (why a feature is off) | Console → "运行快照" ("关闭中的开关"); full fields in `qq-runtime.json` → `features` (never any secret) |
| A bundle to hand to someone else | "导出诊断包" → one zip (events, audit, bridge log, host logs, runtime snapshot, diagnosis, environment) |
| File-level digging | `qq-trace.jsonl` (structured events, jq/grep friendly), `qq-bridge-debug.log`, `qq-actions.log` (write-action audit), `qq-host-out.log` / `err.log` |

Config: `traceEnabled` (on by default), `traceLevel` (`debug` = everything, `warn` = problems only), `traceMemorySize`, `traceFile`.
Debug endpoints (console, token + Origin guarded): `/api/trace`, `/api/stream` (SSE), `/api/runtime`, `/api/diagnose`, `/api/export`.

### Recording · offline replay · event injection (v0.4 phase 3)

The first two answer "what is happening right now"; these three answer "why did *this* message go that way, and what would a different input do".

| Capability | How | Detail |
|---|---|---|
| Recording | automatic | every inbound message/notice/request is appended to `qq-inbox.jsonl` (JSONL, size-rotated). Local file only, never changes how the bot replies |
| Offline replay | console → "录制 · 回放 · 注入" → "回放这条" / "回放最近 5 条" | re-runs that message through the **real bridge code** inside a **sandbox directory**: dry-run intercepts every outbound call, no QQ connection is ever created, the live working directory is not touched. Each entry gets a verdict — replied / silent / error — **with the reason** and what it would send |
| Event injection | console → fill group id / QQ id / text → "注入" | appends a line to `qq-inject.jsonl`; the bridge polls it (`injectIntervalMs`, default 2s) and feeds it through the **real pipeline**. With `injectDryRun` (default on) every outbound call is intercepted and counted, so injected content is never actually sent to QQ |

Replay fidelity comes from the live decision config carried in the runtime snapshot (allowlists, quiet hours, feature switches — 28 keys under `replay` in `qq-runtime.json`); without it the plugin defaults ("empty allowlist = deny everything") would make every replay look silent. Replay does **not** contain real model output: the model turn is replaced by a canned line prefixed with `[回放]`, so it validates the pipeline and the branch, not the wording.

Operational notes:

- if the injection channel is off the console **fails loudly with the switch name** (`injectEnabled`) instead of silently queueing;
- the injected **agent turn is asynchronous**: the dry-run window only covers the synchronous stage, so the model's actual reply is intercepted separately and recorded in the event stream (`injected turn reply suppressed (dry-run, not sent): <text>`). Injection therefore runs the real pipeline without ever leaking a message; a real inbound message clears the mark immediately;
- replayed frames are marked `replay: offline replay (sandbox + dry-run, never touches QQ)` while injected frames are marked `inject`, so the two never get confused;
- lines already present when the bridge starts are skipped, with a recorded reason ("skipped N historical lines, only lines appended after start are processed") — a restart never replays old injections;
- injected frames are never recorded, so injection and replay cannot feed each other;
- replay sandboxes: the newest 5 are kept, older ones are **moved to the recycle/trash directory** (`qq-replay/_trash/<date>/`), never deleted outright.

Config: `recordInbound` (on), `inboxFile`, `inboxRedact`, `injectEnabled` (off), `injectFile`, `injectDryRun` (on), `injectIntervalMs`.
Endpoints: `/api/inbox`, `/api/replay`, `/api/inject`, `/api/queue/clear`.

### Hard-constraint acceptance page (v0.4 phase 4)

The two features above answer "what is happening" and "why did this message go that way". The acceptance page answers the third question: **did the design philosophy actually land?**

`GET /api/acceptance` turns each of the 6 hard constraints into `✅ met / ⚠️ hint / ❌ not met / ❔ not enough evidence`, computed from artefacts that already exist on the machine, plus the evidence and the next step:

| Constraint | Evidence used |
|---|---|
| ① No silent branch | every `ok:false` event (rejected/failed) in the last 500 events must carry a non-empty reason; missing ones are named by stage |
| ② Correlatable (traceId) | traceId coverage of message-scoped events and how many messages actually reached `inbound→reply` |
| ③ Replayable | recording count plus the last replay's stats and **safety** (dry-run on, 0 QQ connections, sandboxed cwd); dry-run being off fails the row |
| ④ Diagnosable | diagnosis pass/fail/blocker counts and verdict, failing checks named |
| ⑤ Exportable | how many of the bundle's source artefacts are present (or the last export's size and filename) |
| ⑥ Injectable | channel switch, dry-run switch (off ⇒ not met, because it would send to QQ), lines consumed, and how many **asynchronous agent-turn replies have been intercepted** |

Every row has a "去看 →" link that jumps to the matching card; the verdict is one of `all-green / partial / unknown / broken`. The evaluator is a pure function (`control/lib/acceptance.mjs`) with every branch asserted in tests, refreshed every 30s and immediately after a replay finishes.

### One-click health report (standalone page `/report`)

The acceptance page is for **yourself**: 18 diagnostic checks and 6 constraints spread over a few cards are hard to send to someone else, archive, or paste into an issue.

`/report` merges the two existing artefacts (per-check diagnosis + the 6 hard constraints) into one report:

- a one-line verdict (`blocked / warnings / unknown / all-green`) plus the key counters;
- **fix these first**: ordered by consequence — blocking checks → failed constraints → warnings, each with a concrete next step, at most 6 rows;
- **the 6 hard constraints** with their evidence and a "去看 →" link back to the matching console card (deep link via `?focus=`);
- **check details** grouped as dependencies / ports & processes / link / runtime snapshot / events / audit & files, failures first in each group;
- **key facts**: bridge version, uptime, sessions, write-gate denials, event count, snapshot age.

The page is **read-only** (it never issues a POST), has zero external dependencies, and turns into black-on-white print output (`Ctrl+P` → save as PDF). "Copy report" uses the server-side `formatHealthReport()` text, so the whole report can be pasted into an issue. Verdict and wording live in `control/lib/report.mjs` (pure functions) and are asserted in `test/report-unit.mjs`.

Endpoint: `GET /api/report[?fresh=1]` (same token + Origin gating as every other endpoint; `fresh=1` bypasses the 5-second diagnosis cache — that is what the page's "re-run" button uses).

### Settings change history (console card)

"Changed it and forgot" is harder to debug than "changed it wrong": path settings, the WebUI port and the WS client URLs live in three different files, and each edit only gives feedback for that one moment.
The console's "设置项变更历史" card keeps the **old → new** of those settings files:

- watched files: `qq-control.json` (console paths/ports), NapCat's `webui.json` and `onebot11_<uin>.json`;
- trigger: only the **settings-writing endpoints** (`POST /api/config`, `/api/accounts/config`, `/api/accounts/network*`) take a snapshot before and after and diff it mechanically; start/stop/replay/inject are *operations* and stay in the event stream / `qq-actions.log` instead;
- storage: `<console working dir at startup>/qq-settings-history.jsonl`, one line per change; over 256 KB it keeps the last 64 KB;
- redaction: `token / secret / password / apiKey` style keys are **never written**, a value change is recorded as `token：*** → ***` (marked as hidden);
- read: `GET /api/history?limit=200&q=keyword` (same token + Origin gating); the page filters instantly by keyword and "copy text" hands over the full text;
- read-only: there is no "restore" button on purpose. To roll back, use the account center's config backups (they copy `.bak` first).

One rule: **snapshots watch files, not endpoint arguments** — endpoints grow and change, files do not, so anything written to the files above is guaranteed to be captured.

### Voice lab (standalone page `/voice`)

A revisit of an older feature: the voice stack (`lib/stt.js` / `lib/tts.js`) used to be verifiable only by sending the bot a voice message, and a failure showed up as nothing but "no transcript / no sound". The console now has a **dedicated page** (`/voice`, entry in the left sidebar) — voice work means trying several voices/languages in a row and re-checking transcripts, which a 30-second auto-refreshing overview would throw away.

| What you want to know | How to try | Notes |
|---|---|---|
| Where the voice module is stuck | status block at the top | switch off / local TTS missing reference audio / cloud key missing / host has no `speechToText` — each blocker carries "where to turn it on" |
| Does TTS actually speak, and with which voice | type a sentence → "合成并试听" | audio plays in the page only, **never sent to QQ**; shows provider / bytes / ms |
| Does STT transcribe, and how well | "开始录音" (say a sentence) or pick an audio file | browser recording (webm/ogg) or any audio file → host ffmpeg converts to 16 kHz mono WAV → local SenseVoice (or cloud); shows transcript, ms, converted size |

**Fine-tuning** (every value is a **per-attempt override**, never written back to config; the page shows only the fields that match the provider):

| provider | knobs |
|---|---|
| Azure | voice, style (`mstts:express-as`), rate % (-50…100), pitch st (-12…12), volume % (-50…50) |
| OpenAI-compatible | voice, `speed` (0.25…4) |
| GPT-SoVITS | reference audio path, reference text, reference language, `speed_factor` (0.5…2), `temperature` (0.01…2), `top_k` (1…100), `top_p` (0…1), `repetition_penalty` (0.5…2), `seed` (-1 = random) |
| STT | recognition language (auto / Chinese / English / Japanese), cloud model id |

**Pitch**: Azure uses native SSML `prosody pitch`; local GPT-SoVITS / OpenAI use the **built-in shifter** (resample + WSOLA,
pitch changes while duration stays roughly the same, ±12 semitones) — a local wav needs no ffmpeg, cloud mp3 only uses ffmpeg
for decoding (a minimal build is enough). Languages in the UI are **auto / Chinese / English / Japanese** (auto by default;
GPT-SoVITS accepts `text_lang=auto` in both v1 and v2 language tables, and it copes with mixed Chinese/English/Japanese).

Out-of-range values **fail loudly with the allowed range** (no silent clamping — "set 3× but got 2×" is far harder to debug); fields left empty are not sent at all, so an older GPT-SoVITS build never chokes on unknown keys. The last 5 samples (player + parameter summary) stay around for A/B. Change values in DSH settings when you want them to persist.

Path: console page → `POST /api/voice/tts|stt` (token + Origin) → supervisor locates the host (① the tokenised URL in `qq-host-out.log`; ② otherwise it recognises the DSH host from local listening ports — a desktop-started host may use a different port each time, and the plugin routes themselves need no token) → host `POST /qqai/voice/{tts,stt}` (same-origin + JSON + size limits) → `lib/voice.js` → `lib/tts.js` / `lib/stt.js`.

Troubleshooting:

- **"找不到宿主" (host not found)**: no tokenised URL in the log (the host was never started by the console) and no DSH host recognised among listening ports — start (or restart) the host once; the status block shows which host address was actually found;
- **"宿主在 …，但没有 /qqai/voice 接口（插件还是更新前的版本）"**: the host is running old plugin code. Plugin hot reload reuses the ESM module cache, so it does not re-evaluate; **restart the host once** (on desktop: restart DSH);
- recording uses the browser's `MediaRecorder` and needs microphone permission; without it, pick an audio file instead;
- ffmpeg must be on PATH (or `ffmpegPath` must point at it) — the same prerequisite as the bot's real voice transcription, and the page reports the actual failure reason;
- **why 16 kHz**: the host's local recognition service (`speechToText`) **only accepts** 16 kHz mono 16-bit WAV (the platform validates it; anything else throws Invalid speech WAV). 16 kHz is also the training sample rate of SenseVoice-class models — 44.1/48 kHz gets downsampled before recognition anyway, so it would not be more accurate. **TTS is not constrained by this**: the page plays the provider's original audio (local GPT-SoVITS is usually 32/44.1 kHz, Azure returns 24 kHz mp3) and shows the real WAV sample rate. When the bridge sends voice to QQ it converts local wav to mp3 (`ttsLocalConvertToMp3`) without lowering the sample rate;
- the page is a local trial only: **it does not go through the QQ send path** and does not change any setting.
