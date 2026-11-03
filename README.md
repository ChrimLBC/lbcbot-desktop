# lbcbot-desktop

The LBCBot desktop app. Bridges OBS and the GreenSplit speedrun timer to LBCBot in **both** directions and sets up
overlay browser sources for you.

> Ships as installers (`.dmg` / `.exe` / `.AppImage`) via electron-builder. **No Docker image, no helm chart** — it is
> not a cluster workload, same as `lbcbot-streamdeck` and `lbcbot-tts`.

## Why there is no native OBS plugin

**obs-websocket v5 ships inside OBS 28+.** Enable it under *Tools → WebSocket Server Settings* and everything the
"OBS plugin" was meant to do is already reachable: scene switching, source visibility, recording and replay buffer
control, and a full event stream. It only ever needed one long-running local process to talk to — this app.

A native C++ plugin would have bought nothing here except per-platform ABI churn, code signing and notarization.
Native *rendering* (replacing the Browser Source) is a separate, much larger question and is deliberately not on the
roadmap: it would mean reimplementing the React widget renderer, animation engine, render budget and emote FX stack in
C++/OpenGL.

## What it does

**OBS → LBCBot** — scene changes, stream start/stop and source show/hide become real LBCBot triggers
(`OBS_SCENE_CHANGED`, `OBS_STREAM_STARTED/STOPPED`, `OBS_SOURCE_SHOWN/HIDDEN`), posted to
`POST /api/users/obs/event`. They run through the normal trigger path, so conditions and cooldowns apply — the
cooldown matters here, because flipping between two scenes would otherwise fire an alert per flip.

**LBCBot → OBS** — the OBS action attached to a trigger is executed here. Subscribes to
`/topic/deviceControl/{userId}` over STOMP on a plain WebSocket (`wss://…/ws/lbcbot/websocket`, the endpoint the
browser overlays use; Node's built-in WebSocket, `@stomp/stompjs`). Supported actions:

| Action | obs-websocket call |
|---|---|
| `SET_SOURCE_VISIBLE` (+ optional `revertAfterSeconds`) | `GetSceneItemList` → `SetSceneItemEnabled` |
| `SWITCH_SCENE` | `SetCurrentProgramScene` |
| `TOGGLE_MUTE` | `SetInputMute` |
| `REFRESH_BROWSER_SOURCE` | `PressInputPropertiesButton` |
| `START_RECORDING` / `STOP_RECORDING` | `StartRecord` / `StopRecord` |
| `SAVE_REPLAY_BUFFER` | `SaveReplayBuffer` |

The server forwards the action as an **opaque JSON string** and never parses it, so adding an action type is a desktop
release with no API deploy and no enum constant. The flip side: nothing validated it on the way here, so unknown types
are logged and ignored rather than thrown.

**One-click overlay setup** — `CreateInput` a correctly sized `browser_source` with a freshly minted scoped overlay
key. The URL is never displayed or copied, which is the point: a component-view URL used to carry the user's Twitch
access *and refresh* token, and the key that replaced it is revocable under **Connected apps** on the website.
Re-running setup updates the existing input rather than piling up `Overlay (2)` next to it.

## GreenSplit (speedrun timer)

[GreenSplit](https://greensplit.net) is a desktop speedrun timer. Like OBS it runs on the streamer's PC, and like OBS
everything it needs is already inside it: two local servers, both off until switched on in GreenSplit's menus. The
bridge is `src/main/greensplit.js` — plain Node, no Electron import, so the mapping, the pace tracker and the adapter
client are all tested directly (`test/greensplit.test.js`, replaying a recorded real session).

**Setting it up**

1. In GreenSplit: **WebSocket Server → Enable WebSocket event server**, then **Copy Connection URL**.
2. Paste it into the GreenSplit card on the Status pane. That is the whole setup — no button needed. The address goes
   into settings and the `token` in it into the keychain, like the OBS password; the field then shows the saved URL
   with the token masked. Only an address on this computer or the local network is accepted (see Security model).
3. To let LBCBot drive the timer too: **LiveSplit Server Adapter → Enable LiveSplit Server Adapter**. It listens on
   16834 on the same host as the Connection URL; the card asks for the port only when it cannot reach the adapter,
   which is the only time the port can be the problem.

**Disconnect** turns GreenSplit off until the next Connect, restarts included (`greensplitEnabled`; the launch
auto-connect needs it as well as "Connect to GreenSplit on launch"). The bin icon forgets the setup entirely —
address and token — back to "Not set up"; pasting the URL again undoes it.

GreenSplit is often opened after this app, so the bridge keeps retrying (2 s, doubling to 30 s) and logs one line per
outage, not one per attempt. A wrong token is silent on GreenSplit's side — the socket opens and nothing is ever sent —
so no `hello` within 5 s shows as **Wrong access token**, and that is not retried: pasting the URL again fixes it.

**GreenSplit → LBCBot** — events become triggers, posted to `POST /api/users/greensplit/event`, one post per trigger
type and strictly in order (a gold split posts `SPLIT`, then `GOLD`, then any pace change). Times are integer
nanoseconds; the API formats them. Gated by **Send GreenSplit events to LBCBot** in Settings. Each post gets 8 s, so
one hung request cannot hold the triggers behind it for long, and a trigger that has waited 30 s is dropped rather
than fired long after the moment it describes; a spell of failures is one log line.

| Trigger | Fires on |
|---|---|
| `GREENSPLIT_RUN_STARTED` | the timer starting |
| `GREENSPLIT_SPLIT` | every split except the last (the last one is the finish) |
| `GREENSPLIT_GOLD` | a best segment, on a split or on the finish — as well as the SPLIT / RUN_FINISHED |
| `GREENSPLIT_PACE_AHEAD` / `_BEHIND` | the pace flipping (see below) |
| `GREENSPLIT_SPLIT_UNDONE` / `_SKIPPED` | an undo / a skipped split |
| `GREENSPLIT_PAUSED` / `_RESUMED` | pause / resume |
| `GREENSPLIT_RUN_FINISHED` | the final split |
| `GREENSPLIT_PERSONAL_BEST` | a finish that beats the PB, at the moment of the finish |
| `GREENSPLIT_RESET` | a reset, finished or not |
| `GREENSPLIT_COMPARISON_CHANGED` | the comparison changing (not "changing" to the one already showing, which GreenSplit also announces) |

The pace is followed here, not in GreenSplit: none at the start, at a reset and on a comparison change; a split or
finish below its comparison time is ahead, above it behind; and mid-segment, the moment the running time passes the
comparison's split time for the segment being run, it is behind (`live: true`) — before the split that would prove it.
Ahead and behind fire only on a change. An undo re-derives the pace from the splits that remain (and the running time)
without firing, so undoing a mistaken split never announces the same pace twice. Timer ticks are subscribed at 4 Hz
only for that live check.

`GREENSPLIT_PERSONAL_BEST` fires from the finish's `personal_best_candidate`, because GreenSplit's own `personal_best`
event only comes at the reset afterwards and never for a first-ever completion. A first completion has no
`previousBestNs`.

Every GreenSplit `hello` also calls `PUT /api/users/integrations/greensplit {appVersion}`, and **Disconnect** (or
forgetting the setup) calls `DELETE` — so the website only offers GreenSplit triggers and actions to someone whose
GreenSplit can fire them. The PUTs and DELETEs go out one at a time in the order asked, so a PUT still in flight can
never land after a Disconnect. Quitting the app is not turning GreenSplit off and tells LBCBot nothing.

**LBCBot → GreenSplit** — a trigger's `greensplitAction` arrives on the same `/topic/deviceControl/{userId}` as the OBS
actions, with `target: "greensplit"` (OBS commands have no target, and a missing target still means OBS —
`src/main/devicecontrol.js`). Executed over the LiveSplit Server Adapter, one `command\r\n` line at a time:

| Action | LiveSplit command |
|---|---|
| `START_TIMER` / `SPLIT` / `START_OR_SPLIT` | `starttimer` / `split` / `startorsplit` |
| `UNDO_SPLIT` / `SKIP_SPLIT` | `unsplit` / `skipsplit` |
| `PAUSE` / `RESUME` | `pause` / `resume` |
| `TOGGLE_PAUSE` | `getcurrenttimerphase`, then `pause` if Running, `resume` if Paused, nothing otherwise |
| `RESET` | `reset` |
| `SET_COMPARISON` `{comparison}` | `setcomparison <comparison>` (a name with a line break is refused) |
| `NEXT_COMPARISON` / `PREVIOUS_COMPARISON` | the next / previous name in the run's comparisons, wrapping, then `setcomparison` |

Like the OBS actions, the action is an opaque JSON string the server never parses: unknown types are logged and
ignored. A command fired by a `GREENSPLIT_*` trigger is ignored outright — a split that fires a trigger that splits
would run the timer away. A comparison name is trimmed, and one still empty (saved mid-typing) sends nothing.

The adapter answers nothing to an action that works but an `[Error]: …` line to one that fails (an unknown
comparison, say), and it answers strictly in order. So every action goes out with `getcurrenttimerphase` straight
after it: an error before the phase is that action's, and the phase means it is done — exact, with no timing guess. A
getter takes only an answer it recognises (a phase is `NotRunning|Running|Paused|Ended`); an error nobody is waiting
for is logged as late, never against the next command. Disconnecting (or GreenSplit closing) drops any command still
waiting or queued, and a connect still in flight, so nothing reaches the timer after GreenSplit is off.

## Security model

- The credential, the OBS password and the GreenSplit access token are encrypted with Electron's **`safeStorage`** (OS
  keychain). Not `keytar` — that is an unmaintained native module needing a rebuild per Electron version, for no extra
  protection. A settings update from the renderer cannot write any of them.
- **The GreenSplit token only goes to this computer or the local network**: localhost, `127.0.0.0/8`, `::1`, the
  private and link-local ranges (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10`) and `.local`
  names. The host is checked when a Connection URL is pasted and again every time the connection URL is built, so an
  address that reached settings any other way (a hand-edited file) is refused with "Can't use that address", and the
  LiveSplit adapter (same host) is refused with it. The renderer cannot write the saved address or the on/off flag at
  all; only a pasted, checked URL changes it. The checks are by host *name*: a `.local` name is trusted to resolve on
  the local network.
- `contextIsolation: true`, `nodeIntegration: false`, and the renderer's entire capability is the verb list in
  `src/preload/index.js`. It holds no credential, makes no API calls and never touches OBS or GreenSplit; a pasted
  Connection URL goes in once and its token never comes back out.
- The renderer sets a strict CSP and builds all DOM with `textContent`; overlay names are user data.
- **Forgetting the credential here does not revoke it.** Revoke under Connected apps on the website.

## Develop

```bash
npm install
npm start          # launches the app (needs a display)
npm run dist       # build installers for the current platform
```

Three environment traps, all of which look like the app is broken (or worse) when it is not:

- **Do not launch from a VS Code integrated terminal.** VS Code exports `ELECTRON_RUN_AS_NODE=1`, which makes
  Electron start as plain Node — `require('electron')` then returns a path string instead of the API and the app
  dies on `Cannot read properties of undefined (reading 'whenReady')`. Use a normal terminal, or
  `env -u ELECTRON_RUN_AS_NODE npm start`.
- **Running from source beside an installed copy raises a macOS keychain prompt** — a different Electron binary asking
  for the installed app's "LBCBot Safe Storage" item. Give the source run its own name and data folder:
  `LBCBOT_DEV_APP_NAME="LBCBot Dev" LBCBOT_DEV_USER_DATA=/tmp/lbcbot-dev npm start` (both ignored when packaged).
- **Electron is on the 45 line** (macOS 27 dev machine). Chromium dropped old macOS releases, so raise it only after checking the minimum macOS it supports.

## Dashboards in their own windows

The **Dashboards** section of the app window lists your dashboards and opens any of them in its own frameless
window. They share one signed-in session, remember their size and position per dashboard, and reopen on the
next launch if they were still open when you quit.

This is also the only place the **Twitch Backstage** widget can do its real job. Twitch serves
`X-Frame-Options: SAMEORIGIN`, so no web page can ever iframe it; here it renders in a `<webview>`, which is a
separate browsing context the header does not apply to. That matters for the two things Twitch exposes **no
API** for:

- **Start Sharing Chat** (Shared Chat has one read-only Helix endpoint and no way to start a session).
- **Raid Now** — `POST /helix/raids` starts the 90-second countdown and there is no parameter or endpoint to
  skip it. Pressing Raid Now in the embedded backstage is the only way to raid immediately.

The Twitch cards need Twitch's own website sign-in, once per install. The credential that connects this app to
LBCBot is not a Twitch web session and cannot stand in for one. Until that sign-in happens, each card keeps a signed-out
Twitch page loaded out of sight, and those pages ask for a passkey by themselves as soon as they load. Left alone, that
locks the dashboard behind a Windows dialog, so passkeys are switched off on twitch.tv in this app (`src/main/twitchPasskeys.js`).
**Sign in to Twitch with a password here; passkeys do not work.**

## Releasing, and how an installed copy updates itself

Tag and push; the Windows workflow does the rest.

```bash
git tag v1.0.3 && git push origin v1.0.3
```

**The tag is the version.** The workflow writes `${TAG#v}` into `package.json` before building, so the version
compiled into the app always matches the release it came from. This is not tidiness — it is the thing that makes
updates work, and getting it wrong is silent. v1.0.1 was tagged without bumping `package.json`, so it shipped an
app that still called itself 1.0.0; every installed copy compared 1.0.0 to 1.0.0, decided it was current, and the
release reached nobody while the release page looked perfectly healthy.

**The tag must start with `v`.** The workflow only fires on `v*` tags, so `1.0.9` and `1.0.10` (pushed without the
`v`) built nothing in CI — they were built and uploaded from the Mac by hand. Use `v1.0.11`, never `1.0.11`.

**Release from CI, not from the Mac.** `npm run dist:win` works on macOS, but electron-builder can only produce the
NSIS uninstaller there through a workaround (it extracts it from the installer rather than running it), and the
uninstaller is the one piece that runs on the *next* update — an update first runs the installed version's
uninstaller. The Windows runner builds it natively. A Windows run takes about two minutes, billed at 2x.

**Three files make a release, not one.** `electron-builder` writes `latest.yml` beside the installer, and that
file — version, filename, sha512 — is the only thing an installed copy reads to discover a new version exists.
The `.blockmap` lets the updater fetch just the changed chunks. Publishing only the `.exe` produces releases that
are invisible to everyone who already has the app.

An installed app checks on launch and every six hours, downloads in the background, and then **waits**: the
Settings pane offers a Restart button and the update otherwise applies on the next normal quit. Nothing restarts
itself — this app is open while someone is live.

**Windows only.** Squirrel.Mac refuses to update an app that is not code-signed, so a mac build cannot
self-update until there is a Developer ID certificate; the Settings pane says so there rather than pretending to
check. There is also no mac build in CI yet — the website's download button is the Windows installer.

> Anyone running a build from **before** v1.0.2 has no updater in it at all and has to download the installer
> once by hand. Self-updating starts from the version after that.

## Known gaps

- **Never run against real OBS.** Module loading, the action vocabulary (every type verified against a stubbed
  obs-websocket client), the not-found path and the revert-timer behaviour are all checked; nothing else is.
- **GreenSplit was never run inside the Electron app.** The bridge was driven from plain Node against a real
  GreenSplit 0.3.4 (headless Linux build): every action, every forwarded event type, the wrong-token, closed-app and
  adapter-off states. The card was checked in a browser with a stubbed bridge. Windows and macOS builds of GreenSplit
  were not tried.
- **GreenSplit: real time only.** Game time, subsplit sections and the `run_saved` / `attempt_committed` bookkeeping
  are not forwarded; `totalSplits` counts every segment, subsplits included.
- **GreenSplit: a wrong token leaves one socket open** until GreenSplit quits — GreenSplit never answers its close.
  Not retried, so it is one per attempt.
- **GreenSplit's LiveSplit adapter has no authentication** (GreenSplit's design): anything on the machine — or the
  network, with "Allow other devices" on — can drive the timer, with or without this app.
- **No tray mode** — closing the window quits, so the bridge stops. Fine for "launch it when you stream", wrong for
  "always on".
- **No audio deck yet.** Browser-based song playback still lives in the website's `/song-queue` tab
  (`BrowserPlayer.js`), and TTS still plays inside the overlay browser source. Owning audio properly is the obvious
  next feature and the main reason to want this app running anyway.
- **No global hotkeys.**
- **No installer distribution yet.** `npm run dist` builds locally, but nothing is signed, notarized or
  published, so there is no download link on the website. macOS will gatekeeper an unsigned `.dmg`.
- **Endpoints are fixed.** A packaged build always uses `https://lbcbot.com` and `https://api.lbcbot.com` (`src/main/sites.js`); there is no setting, and any `apiUrl`/`siteUrl` in an old `settings.json` is ignored and dropped. From source (`npm start`), `LBCBOT_SITE_URL` / `LBCBOT_API_URL` override them for local development.
