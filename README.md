# lbcbot-desktop

The LBCBot desktop app. Bridges OBS and LBCBot in **both** directions and sets up overlay browser sources for you.

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
`/topic/deviceControl/{userId}` over SockJS+STOMP (the same stack the browser overlays use; `sockjs-client` works
unchanged in Node). Supported actions:

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

## Security model

- The credential and the OBS password are encrypted with Electron's **`safeStorage`** (OS keychain). Not `keytar` —
  that is an unmaintained native module needing a rebuild per Electron version, for no extra protection.
- `contextIsolation: true`, `nodeIntegration: false`, and the renderer's entire capability is the verb list in
  `src/preload/index.js`. It holds no credential, makes no API calls and never touches OBS.
- The renderer sets a strict CSP and builds all DOM with `textContent`; overlay names are user data.
- **Forgetting the credential here does not revoke it.** Revoke under Connected apps on the website.

## Develop

```bash
npm install
npm start          # launches the app (needs a display)
npm run dist       # build installers for the current platform
```

Two environment traps, both of which look like the app is broken when it is not:

- **Do not launch from a VS Code integrated terminal.** VS Code exports `ELECTRON_RUN_AS_NODE=1`, which makes
  Electron start as plain Node — `require('electron')` then returns a path string instead of the API and the app
  dies on `Cannot read properties of undefined (reading 'whenReady')`. Use a normal terminal, or
  `env -u ELECTRON_RUN_AS_NODE npm start`.
- **Electron is pinned to 43 for macOS 12.** Chromium dropped Monterey, so Electron 44+ needs macOS 13 Ventura
  and aborts on 12 with `Symbol not found: _objc_claimAutoreleasedReturnValue`. 43 is the last line that runs
  there; apps built on it still run on newer macOS, so pinning costs no users. Only raise this once the dev
  machine is on Ventura or later.

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
- **No tray mode** — closing the window quits, so the bridge stops. Fine for "launch it when you stream", wrong for
  "always on".
- **No audio deck yet.** Browser-based song playback still lives in the website's `/song-queue` tab
  (`BrowserPlayer.js`), and TTS still plays inside the overlay browser source. Owning audio properly is the obvious
  next feature and the main reason to want this app running anyway.
- **No global hotkeys.**
- **No installer distribution yet.** `npm run dist` builds locally, but nothing is signed, notarized or
  published, so there is no download link on the website. macOS will gatekeeper an unsigned `.dmg`.
- `siteUrl` must match where the frontend is served, or the browser sources it creates will point at the wrong host.
