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

## Known gaps

- **Never run against real OBS.** Module loading, the action vocabulary (every type verified against a stubbed
  obs-websocket client), the not-found path and the revert-timer behaviour are all checked; nothing else is.
- **No tray mode** — closing the window quits, so the bridge stops. Fine for "launch it when you stream", wrong for
  "always on".
- **No audio deck yet.** Browser-based song playback still lives in the website's `/song-queue` tab
  (`BrowserPlayer.js`), and TTS still plays inside the overlay browser source. Owning audio properly is the obvious
  next feature and the main reason to want this app running anyway.
- **No global hotkeys**, and the website's control pages are not embedded.
- `siteUrl` must match where the frontend is served, or the browser sources it creates will point at the wrong host.
