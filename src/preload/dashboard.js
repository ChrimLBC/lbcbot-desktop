'use strict';

/**
 * The ONLY thing a dashboard window's preload does: hand the page this machine's LBCBot credential.
 *
 * <h3>Why a dashboard window needed this at all</h3>
 *
 * The app connects to LBCBot once, through the device-authorization grant, and keeps an opaque `lbc_dk_…`
 * credential. A dashboard window, though, is a fresh browser profile on the `persist:lbcbot-dashboard` partition
 * — it knows nothing about that credential, so it rendered the website's signed-out page and asked the user to
 * log in again. Following that prompt leads to Twitch's OAuth screen inside an embedded window, which is exactly
 * where a Twitch sign-in cannot be completed. The result was a user stuck at a login screen on a machine that was
 * already connected to their account.
 *
 * It looked Windows-only for an unrelated reason: a Mac that had signed in at some point had a populated
 * partition on disk, so the window was already authenticated and the prompt never appeared. A fresh install
 * anywhere shows it.
 *
 * <h3>Why this file is as small as it is</h3>
 *
 * These windows render a REMOTE page and must stay untrusted — the app's own renderer is the one that holds the
 * IPC bridge, and nothing here may widen that. So this exposes no API, no `contextBridge` surface and no
 * `ipcRenderer`: it writes one string into localStorage on our own origin and stops. `contextIsolation` stays on.
 *
 * It is a preload rather than a query parameter so the credential never appears in a URL, and rather than an
 * `executeJavaScript` call because a preload is guaranteed to run **before** the page's own scripts — the page
 * reads this key during startup, so anything racing that would work only intermittently.
 *
 * The page exchanges it at `/api/token` for a short-lived JWT and re-exchanges on a timer, the same path a
 * browser source uses for an overlay key. The credential itself is what the machine already holds; putting it on
 * our own origin in a dedicated partition is equivalent to that window being logged in, which is the point.
 */

const { ipcRenderer } = require('electron');

// Must match LOCAL_STORAGE.DESKTOP_CREDENTIAL in LBCBot-frontend/src/constants/index.js. The two are separate
// codebases, so a rename there silently stops desktop dashboards signing themselves in — they fall back to the
// login page rather than erroring, which is the quiet kind of break.
const DESKTOP_CREDENTIAL_KEY = 'DESKTOP_CREDENTIAL';

const credential = ipcRenderer.sendSync('dashboard-credential');

try {
    if (credential) {
        window.localStorage.setItem(DESKTOP_CREDENTIAL_KEY, credential);
    } else {
        // Disconnected since the window was last opened: clear it, so the page stops trying to exchange a
        // credential this machine no longer has and shows the ordinary signed-out page instead.
        window.localStorage.removeItem(DESKTOP_CREDENTIAL_KEY);
    }
} catch (error) {
    // Storage disabled or partitioned away. The page simply shows its login — no worse than before this existed.
    console.warn('[lbcbot] could not seed the desktop credential:', error && error.message);
}
