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
 * page (the main process checks the window and its address), and the account menu's three calls below (2026-11-20),
 * under the same check. `contextIsolation` stays on.
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
    /**
     * { accessToken, expiresIn, userId } for this machine's account; null when the app has no usable credential; a
     * rejection when LBCBot cannot be reached (try again later). `{ fresh: true }` exchanges anew: after the API refused
     * the token the page holds.
     */
    sessionToken: (options) => ipcRenderer.invoke('dashboard-session', !!(options && options.fresh)),

    /*
     * The accounts this computer is signed in to, for the page's account menu: `[{ id, userId, username, platform,
     * active, signedOut }]`, never a credential. `switchAccount(id)` makes one the account in use and reloads every
     * other dashboard window (the asking page reloads itself once it answers `{ ok }`). `addAccount()` starts the same
     * sign-in as the app's account menu: `{ ok, userCode, verificationUri }` as soon as the code is out, and when it is
     * approved the new account is the one in use and every dashboard window reloads as it.
     */
    accounts: () => ipcRenderer.invoke('dashboard-accounts'),
    switchAccount: (id) => ipcRenderer.invoke('dashboard-switch-account', String(id)),
    addAccount: () => ipcRenderer.invoke('dashboard-add-account'),
    /* How an add ended, `{ ok, error }`, so the menu stops showing its code. Answers a function that stops listening. */
    onAddAccountDone: (callback) => {
        const listener = (_event, outcome) => callback(outcome);
        ipcRenderer.on('dashboard-add-account-done', listener);
        return () => ipcRenderer.removeListener('dashboard-add-account-done', listener);
    },
});
