# Agent Web UI

A web-based frontend for interacting with the Cursor Agent (or Claude Code) CLI. Provides a chat interface, scheduled tasks, external changelogs, report viewing, a `.env` editor, and an optional Telegram bridge — all from a single Node.js server.

## What It Does

- **Chat** — Send prompts to the Cursor Agent or Claude Code CLI via a browser. Supports model selection, mode switching (Agent/Plan/Ask), session history, streaming responses with thinking/tool-use visibility, and text-to-speech playback.
- **Scheduled tasks** — Run prompts on a cron schedule or trigger them via webhook. Optionally send the output to Telegram.
- **External changelogs** — Accept status updates from other machines (e.g. another laptop) via a simple POST API. Entries are stored and also appended to the AI OS daily log.
- **Assets** — Browse saved HTML/markdown outputs and workspace report files. View in-place (iframe) or copy shareable links.
- **Settings / .env editor** — Edit the project `.env` file directly from the browser (useful when the server is running remotely and you're on your phone).
- **Telegram bridge** — Mirrors the chat interface over Telegram. Message the bot to talk to the same agent with the same workspace. Supports voice notes (STT), reply-with-audio (TTS), conversation threads, and model/agent switching.
- **Password protection** — Optional password gate for the entire UI and API.

## What It Does Not Do

- **It is not a standalone AI** — It proxies to a locally installed CLI (`agent` or `claude`). The CLI must be available on the server's PATH.
- **It does not manage users** — There is one password for the whole UI (or no password). There are no user accounts or roles.
- **It does not run in the cloud out of the box** — It's designed for local/home-server use. For public exposure, put it behind a reverse proxy with HTTPS.
- **It does not persist chat state across server restarts in memory** — Conversations are saved to disk as JSON, but in-memory session state (e.g. the running process handle) is lost on restart. You can resume conversations via the session ID.

## Setup

### Prerequisites

- **Node.js** 18+ (uses native `fetch`, `AbortSignal.any`, and `FormData`)
- **Cursor Agent CLI** (`agent`) or **Claude Code CLI** (`claude`) installed and on PATH
- An active **Claude Code / Cursor** subscription (the CLI handles authentication)

### Install

```bash
cd apps/agent-web
npm install
```

### Configure

All configuration is via the project-root `.env` file (two directories up from this folder). Copy `.env.example` if you haven't already:

```bash
cp ../../.env.example ../../.env
```

Then edit `../../.env` to set your values (or use the Settings page in the web UI once the server is running).

### Run

```bash
npm start
```

The server starts on port 3111 by default. Open `http://localhost:3111` (or `http://<your-server-ip>:3111` from another device).

## Environment Variables

All variables are optional unless noted. Set them in the project root `.env` file.

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3111` | HTTP server port |
| `WORKSPACE` | `../..` (repo root) | Absolute path to the workspace the agent operates on |
| `AGENT_BIN` | `agent` | Path or name of the Cursor Agent CLI binary |
| `CLAUDE_BIN` | `claude` | Path or name of the Claude Code CLI binary |
| `AGENT_CLI` | `agent` | Which CLI to use by default: `agent` or `claude` |
| `AGENT_AUTO_MODEL` | _(none)_ | When the model is set to "auto", override the CLI's default model (e.g. `gpt-5.2-codex`) |
| `TZ` | `Europe/London` | Timezone for cron schedules and the context timestamp injected into prompts |
| `DEBUG` | `1` | Set to `1` for verbose server logs (currently always on) |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_WEB_PASSWORD` | _(none)_ | If set, the UI and all API endpoints require login. A password form is shown at `/login`. Auth is via an HTTP-only cookie (HMAC-SHA256, 7-day expiry). |

### Telegram Bridge

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | _(none)_ | Bot token from @BotFather. Enables the Telegram bridge when set. |
| `TELEGRAM_ENABLED` | `1` | Set to `0`, `false`, or `off` to disable Telegram polling even when a token is set. |
| `TELEGRAM_ALLOWED_USER_IDS` | _(none)_ | Comma-separated Telegram user IDs. Only these users can interact with the bot. If empty, all messages are rejected with a helpful error. Get your ID from `@userinfobot`. |
| `TELEGRAM_REMINDER_CHAT_ID` | first allowed ID | Chat ID for scheduled-job Telegram reminders. Defaults to the first entry in `TELEGRAM_ALLOWED_USER_IDS`. |

### Scheduled Tasks & Changelogs

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULED_WEBHOOK_SECRET` | _(none)_ | Default secret for triggering scheduled jobs via `POST /api/scheduled/trigger`. Individual jobs can also have their own `webhookSecret`. |
| `CHANGELOG_SECRET` | _(none)_ | Shared secret for external systems to POST to `/api/changelogs`. Send via `Authorization: Bearer <secret>` or `X-Changelog-Secret` header. |

### Outputs & Assets

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_WEB_URL` | _(none)_ | Base URL of this server (e.g. `http://192.168.0.226:3111`). Used by skills that publish reports and send links via Telegram. |
| `AGENT_WEB_OUTPUT_SECRET` | _(none)_ | If set, scripts can POST to `/api/outputs` with `Authorization: Bearer <secret>` without needing a login cookie. |

### Voice (TTS / STT)

The Telegram bridge and the "Listen" button in the chat UI use the TTS/STT script from the `telegram` skill. These variables control voice behaviour:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | _(none)_ | Preferred provider for STT (transcription) and TTS (speech). |
| `OPENROUTER_AUDIO_MODEL` | `openai/gpt-4o-audio-preview` | OpenRouter model for STT + TTS. Use `openai/gpt-audio-mini` for lower cost. |
| `OPENAI_API_KEY` | _(none)_ | Fallback for STT (Whisper) and TTS. |
| `TTS_VOICE` | `alloy` | Voice for TTS output (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer). |
| `TTS_SPEED` | `1.1` | TTS playback speed (0.5–2.0). |
| `TTS_LANGUAGE` | `British English` | Accent/language hint for TTS. |

## API Reference

### Chat

WebSocket-based. Connect to `ws://host:port/` and send JSON messages:

| Message type | Direction | Description |
|--------------|-----------|-------------|
| `prompt` | client → server | `{ type: "prompt", prompt, model?, mode?, cli?, sessionId? }` |
| `cancel` | client → server | `{ type: "cancel" }` — kills the running agent process |
| `list-sessions` | client → server | Request active sessions |
| `list-models` | client → server | Request available models from the CLI |
| `list-agents` | client → server | Request available CLI profiles |
| `set-agent` | client → server | `{ type: "set-agent", cli: "agent" \| "claude" }` |
| `agent-event` | server → client | Streamed events from the CLI (thinking, assistant, tool_use, tool_result, result) |
| `agent-done` | server → client | `{ type: "agent-done", code, sessionId }` |

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/conversations` | cookie | List saved conversations |
| GET | `/api/conversations/:id` | cookie | Get a conversation's messages |
| GET | `/api/agents` | cookie | List CLI profiles and current default |
| POST | `/api/agents` | cookie | Switch default CLI: `{ cli: "agent" }` |
| GET | `/api/scheduled` | cookie | List scheduled jobs (secrets redacted) |
| PUT | `/api/scheduled` | cookie | Save all jobs: `{ jobs: [...] }` |
| POST | `/api/scheduled/save` | cookie | Same as PUT (convenience alias) |
| POST | `/api/scheduled/trigger` | cookie or secret | Trigger a job: `{ id, secret? }` |
| GET | `/api/changelogs` | cookie | List recent changelog entries |
| POST | `/api/changelogs` | cookie or secret | Add entry: `{ content, source?, date? }` |
| GET | `/api/outputs` | cookie | List saved outputs |
| POST | `/api/outputs` | cookie or secret | Save output: `{ title, html? \| markdown? }` |
| GET | `/output/:id` | public | View a saved output (HTML page) |
| GET | `/api/assets` | cookie | List outputs + report files |
| GET | `/reports/:filename` | public | Serve a file from workspace `.tmp/` |
| POST | `/api/tts` | cookie | Text-to-speech: `{ text, voice?, speed?, language? }` → audio/mpeg |
| GET | `/api/env` | cookie | Read `.env` file contents and `.env.example` vars |
| PUT | `/api/env` | cookie | Write `.env` file: `{ raw: "full file content" }` |
| GET | `/api/openapi.json` | public | OpenAPI 3.0 spec for changelogs + scheduled APIs |

### Public vs Protected Endpoints

When `AGENT_WEB_PASSWORD` is set:
- `/login` (GET/POST), `/api/openapi.json`, `/output/:id`, and `/reports/:filename` are **public** (no auth required)
- `/api/outputs` POST accepts `Authorization: Bearer <AGENT_WEB_OUTPUT_SECRET>` without a cookie
- `/api/changelogs` POST accepts `Authorization: Bearer <CHANGELOG_SECRET>` without a cookie
- Everything else requires a valid auth cookie (set via `/login`)

## Data Storage

All data is stored as flat files under `apps/agent-web/data/`:

| Path | Contents |
|------|----------|
| `data/conversations/*.json` | Chat conversation history (one file per session) |
| `data/scheduled-jobs.json` | Scheduled job definitions |
| `data/changelogs/*.json` | External changelog entries |
| `data/outputs/*.html` + `*.meta.json` | Saved HTML outputs (reports) |
| `data/telegram-chat-state.json` | Per-chat Telegram state (session, model, voice toggle) |

## Architecture

```
Browser / Telegram
       │
       ▼
  server.js (Express + WebSocket)
       │
       ├── WebSocket handler ──► spawns `agent` or `claude` CLI
       │                         streams JSON events back
       │
       ├── REST API ──► conversations, scheduled, changelogs,
       │                outputs, assets, .env editor, TTS
       │
       └── Telegram poller ──► long-polls Telegram Bot API
                                dispatches to same CLI spawn logic
```

The server is a single-process Node.js app. Each chat prompt spawns a child process (`agent` or `claude` CLI) with `--output-format stream-json`. The server parses the JSON event stream and forwards it to the WebSocket client (or Telegram chat) in real time.

## Telegram Commands

When the Telegram bridge is active, these commands are available:

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh conversation |
| `/convos` | List recent conversations |
| `/convo <n>` | Switch to conversation n |
| `/model <name>` | Set model (e.g. `sonnet`, `opus`, `auto`) |
| `/agent <name>` | Switch CLI backend (`agent` or `claude`) |
| `/voice` or `/graham` | Toggle reply-with-audio (TTS) |
| `/status` | Show current settings |
| `/help` | Show available commands |

Voice notes are automatically transcribed (STT) and processed as text.

## Security Considerations

- **Password protection** is the primary auth mechanism. When `AGENT_WEB_PASSWORD` is set, all API and WebSocket requests require authentication via an HTTP-only cookie.
- **The auth cookie** uses HMAC-SHA256 with timing-safe comparison. It is `httpOnly` and `sameSite: lax`, valid for 7 days.
- **The `.env` editor** is only accessible to authenticated users (behind the same password gate). A `.env.bak` backup is created before every save.
- **Outputs and reports** served at `/output/:id` and `/reports/:filename` are publicly accessible by design (so links can be shared via Telegram). Do not put sensitive content in outputs.
- **The agent CLI runs with full permissions** (`--dangerously-skip-permissions` for Claude Code, `--trust --force` for Cursor Agent). This is required for unattended operation. The password gate is the access control layer.
- **Telegram allowlist** (`TELEGRAM_ALLOWED_USER_IDS`) controls who can message the bot. Without it, all messages are rejected.
- **For public/internet exposure**: put this behind a reverse proxy (e.g. nginx, Caddy) with HTTPS. The server itself is HTTP-only.

