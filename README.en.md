# dsh-session-autarchive

<img src="assets/icon-180.png" width="96" align="right" alt="dsh-session-autarchive">

[中文](README.md) | **English**

Archives sessions that have gone unused for longer than a configurable number of days (5 by default). Archived sessions, pinned sessions (exempt by default), and sessions marked "do not auto-archive" are skipped. A session context-menu item marks a single session, and a field in General settings changes the threshold.

## Where it shows up

| Where | What it looks like | What it does |
|---|---|---|
| Session context menu | One row, "Do not auto-archive", next to Pin / Rename / Fork / Archive | Click once to mark, again to unmark |
| Session row start | A small shield on marked sessions | Shows at a glance that the session is protected |
| Hover card | One line, "Not auto-archived" | Same, with text |
| General settings | A row at the bottom, "Auto-archive after (days)" | Saved on blur or Enter, writes the same host field |

## How it decides and runs

- **Decision**: scan `$DSH_HOME/sessions/<workspace>/session-*` directories, take the newest file time inside each as "last activity". Sessions older than the threshold (5 days by default), not yet archived, not on the protected list, and not pinned (pinning is exempt by default) become pending sessions.
- **Execution**: the host runs a round every 10 minutes (the first one 60 seconds after start, so it keeps running even with no window open); the browser half polls the pending list every 5 minutes and archives through the official channel when it is available, so the sidebar updates immediately.
- Archiving goes through the official `archiveSession` call. It does not delete data: archived sessions stay in the archive list and can be restored.

## Install

```sh
dsh plugin --profile desktop add github:taoziliyouchong/dsh-session-autarchive
```

Restart DSH afterwards. Replace `desktop` with your own profile name if you use another one.

Compatible with DSH 0.2.1-rc.5 (tested); 0.3 and later are not guaranteed.

Once published to npm, this also works:

```sh
dsh plugin --profile desktop add dsh-session-autarchive
```

**It is enabled by default with a 5-day threshold.** Installing it starts archiving by that rule. To turn it off first:

```sh
# tool dsh-session-autarchive, action=config, enabled=false
```

## Tool

The tool is named `dsh-session-autarchive` and takes five actions:

| action | What it does |
|---|---|
| `status` (default) | Configuration summary, pending sessions, protected list, last run |
| `run` | Archive the pending sessions now; `dryRun: true` lists them without touching anything |
| `protect` | Mark one session "do not auto-archive" (needs `sessionId`) |
| `unprotect` | Remove the mark |
| `config` | Change `days`, `enabled`, `exemptPinned` |

## Data files

All under `$DSH_HOME/session-autarchive/`:

| File | Written by | Notes |
|---|---|---|
| `protected.json` | protect / unprotect only | The single source of the protected list. The archive timer never writes it, so a run cannot wash the marks away. |
| `state.json` | archive rounds, config | Switch, threshold, pin exemption, last run result; holds no list. |
| `audit.log` | list changes, every round | One line each, so a lost mark can be traced by time. |

Writes are temp-file-then-rename, and reads retry — a half-written file is never mistaken for "no list" and overwritten with defaults.

## How it works

- The host half registers four local routes: `GET /dsh-session-autarchive/api/state`, `POST .../protect`, `POST .../config`, `POST .../run`. Loopback addresses only (`127.*`, `::1`, `::ffff:127.*`); anything else gets 403, a wrong method gets 405.
- The browser half mounts four slots (menu row, row start, hover card, settings row). Services are probed with `ctx.get`; when one is missing that entry is skipped and the others still mount.
- No network access, nothing uploaded. Decisions use local file times only.

## Known limits

- Without a `workspaceRegistry` service on the host side, the host can only list pending sessions and cannot archive by itself; the browser half then executes through the official channel.
- Only sessions stored under `$DSH_HOME/sessions` are considered.
- Do not install another auto-archive plugin alongside this one: the same UI slots can only be claimed once, and duplicates show the menu row and the settings row twice.
- Enabled by default: it starts archiving at the 5-day threshold right after install. To watch first, set `enabled` to `false` or raise `days`.

## Development

The source has two halves:

- `index.js` — host side (decision, archiving, four routes, the tool)
- `src/entry.jsx` — browser side (menu row, row shield, hover line, settings row, the 5-minute fast path)

Editing `src/entry.jsx` requires rebuilding. `lib/client.js` is a build artifact committed to the repository; without it the UI does not load:

```sh
npm install
npm run build:client    # regenerate lib/client.js
npm run check:client    # verify the committed artifact matches the source
npm run smoke           # structure / bundle manifest / registration / authorization / state / artifact
npm run check           # syntax
```

The smoke run uses a temporary `$DSH_HOME`; it never reads or changes your session data. Build rules: keep `react` and `react/jsx-runtime` external (the DSH client module table provides them); the `id` inside the `window.__ModuleLoader__.load({ id, factory })` envelope must equal the package name.

## License

MIT
