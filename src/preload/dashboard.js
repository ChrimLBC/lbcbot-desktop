'use strict';

/**
 * The ONLY thing a dashboard window's preload does: let the page ask this app for a session token.
 *
 * <h3>Why a dashboard window needs this at all</h3>
 *
 * The app connects to LBCBot once, through the device-authorization grant, and keeps an opaque `lbc_dk_…`
 * credential in the OS keychain. A dashboard window, though, is a fresh browser profile on the
 * `persist:lbcbot-dashboard` partition — it knows nothing about that credential, so without this it renders the
 * website's signed-out page, whose Twitch sign-in cannot be completed inside an embedded window.
 *
 * <h3>Why a token and not the credential (1.0.14)</h3>
 *
 * Until 1.0.14 this preload wrote the credential itself into the page's localStorage. That storage is a plain file in
 * the window's partition, readable by anything running as the user — exactly what credential-stealing malware
 * collects — and it undid the keychain that guards the credential everywhere else. Now the main process exchanges the
 * credential and the page only ever gets the hour-long token that comes back (`sessionToken()`, asked again before it
 * runs out). A copy taken from this window's storage is dead within the hour.
 *
 * <h3>Why this file is as small as it is</h3>
 *
 * These windows render a REMOTE page and must stay untrusted: the app's own renderer is the one that holds the IPC
 * bridge, and nothing here may widen that. So this exposes one function that answers with a token for our own site's
 * page (the main process checks the window and its address), and nothing else. `contextIsolation` stays on.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Must match LOCAL_STORAGE.DESKTOP_CREDENTIAL in LBCBot-frontend/src/constants/index.js: what an older version of this
// preload left in the page's storage. Removed on every load, so no copy of the credential stays on disk.
const DESKTOP_CREDENTIAL_KEY = 'DESKTOP_CREDENTIAL';

try {
    window.localStorage.removeItem(DESKTOP_CREDENTIAL_KEY);
} catch (error) {
    // Storage disabled or partitioned away: there is nothing in it to remove.
}

contextBridge.exposeInMainWorld('lbcbotDesktop', {
    /** { accessToken, expiresIn, userId } for this machine's account, or null when the app is not connected. */
    sessionToken: () => ipcRenderer.invoke('dashboard-session'),
});
