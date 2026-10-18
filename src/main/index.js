'use strict';

const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const store = require('./store');
const { LbcBot } = require('./lbcbot');
const { ObsBridge } = require('./obs');

/**
 * Main process: owns both connections and relays between them.
 *
 * The renderer is a status/settings panel only — it holds no credential and makes no API calls. Everything privileged
 * stays here behind a narrow IPC surface (see src/preload/index.js), with `contextIsolation` on and `nodeIntegration`
 * off, so a compromised renderer cannot read the keychain or reach OBS.
 */

let mainWindow = null;
let lbcbot = null;
let obs = null;

/** Bounded in-memory log; the renderer renders it and it is the only place a user sees what the bridge is doing. */
const LOG_LIMIT = 300;
const logLines = [];

function log(message) {
    const line = `${new Date().toLocaleTimeString()}  ${message}`;
    logLines.push(line);
    if (logLines.length > LOG_LIMIT) {
        logLines.shift();
    }
    console.log('[lbcbot]', message);
    send('log', line);
}

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 960,
        height: 700,
        // The sidebar is a fixed 200px, so below this the content column gets uncomfortably narrow and the
        // two-column rows (label + input + button) start wrapping.
        minWidth: 720,
        minHeight: 520,
        title: 'LBCBot',
        backgroundColor: '#15161a',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

/**
 * The session every dashboard and Twitch window shares.
 *
 * Must stay in step with the `partition` the web app's Twitch Backstage widget puts on its `<webview>` — a
 * mismatch there is not an error, just a second, signed-out Twitch session inside the embed.
 */
const DASHBOARD_PARTITION = 'persist:lbcbot-dashboard';

/**
 * A standard Chrome user agent with our own token appended.
 *
 * Two jobs in one string. Electron's default UA advertises "Electron", which some sign-in flows challenge —
 * Twitch's included — so the bulk of this has to look like ordinary Chrome. The trailing token is how the
 * WEB APP detects it is running inside the desktop app, which is what lets a widget render a live `<webview>`
 * embed here and a plain "open in a tab" button in a browser. Sniffing for "Electron" would have worked until
 * the moment we hid it, so the two needs are deliberately solved by the same line.
 */
const DASHBOARD_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/128.0.0.0 Safari/537.36 LBCBotDesktop/1.0';

/** Open dashboard windows, keyed by dashboardId (the string '' stands for the no-id picker window). */
const dashboardWindows = new Map();

/**
 * Where a link is allowed to open: Twitch stays in-app on the logged-in partition, everything else leaves.
 *
 * Twitch's backstage is the whole reason for being here — bouncing it to the system browser would mean a second
 * login and lose the point. A docs link is the opposite: it must not replace the control surface a streamer is
 * using mid-stream.
 */
const windowOpenPolicy = ({ url: target }) => {
    if (/^https:\/\/([a-z0-9-]+\.)*twitch\.tv\//i.test(target || '')) {
        openTwitchWindow(target);
        return { action: 'deny' };
    }
    if (/^https?:\/\//i.test(target || '')) {
        shell.openExternal(target);
    }
    return { action: 'deny' };
};

/** Set on before-quit so a window closing during shutdown is remembered as "was open", not "user closed it". */
let isQuitting = false;

/**
 * Keep a saved rectangle on an actually-attached display.
 *
 * Monitors come and go — unplug the second screen and yesterday's coordinates put a window somewhere you
 * cannot see or drag back. Anything not substantially overlapping a real display falls back to centred
 * defaults rather than being restored faithfully into the void.
 */
function usableBounds(saved) {
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)
        || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
        return null;
    }
    const visible = screen.getAllDisplays().some((d) => {
        const w = d.workArea;
        const overlapX = Math.min(saved.x + saved.width, w.x + w.width) - Math.max(saved.x, w.x);
        const overlapY = Math.min(saved.y + saved.height, w.y + w.height) - Math.max(saved.y, w.y);
        // Require a decent patch on screen, not a single pixel of corner.
        return overlapX > 120 && overlapY > 80;
    });
    return visible ? saved : null;
}

/**
 * The streamer dashboard, in its own window — the whole point being that you do not have to go and find a
 * browser mid-stream. Several may be open at once, one per dashboard.
 *
 * <p>It LOADS the hosted site's chrome-free dashboard view rather than bundling a copy of the React app. The
 * frontend is a webpack build with a committed `build/` directory; vendoring it here would mean shipping a
 * second copy of the entire widget stack in every desktop release, and it would go stale the moment the site
 * deployed.
 *
 * <p>Deliberate choices:
 * <ul>
 *   <li><b>One shared persistent partition.</b> Sign in once and every dashboard window is signed in, across
 *       restarts, isolated from anything else the app does.</li>
 *   <li><b>No preload, and emphatically no nodeIntegration.</b> These windows render a remote page. The app's
 *       own renderer is trusted and holds the IPC bridge; these must not.</li>
 *   <li><b>`webviewTag` on.</b> This is what lets the Twitch Backstage widget embed Twitch's own backstage,
 *       which `X-Frame-Options: SAMEORIGIN` makes impossible in an ordinary iframe — a `<webview>` is a
 *       separate browsing context, so the header does not apply. It is a real widening of what this window
 *       can do, accepted because it only ever loads our own site and webview content is process-isolated
 *       from the host page.</li>
 *   <li><b>Twitch links open in-app; everything else leaves.</b> A docs link should go to the real browser,
 *       but Twitch's backstage is the whole point of being here and must stay on this logged-in partition.</li>
 * </ul>
 */
function openDashboardWindow(dashboardId) {
    const key = dashboardId == null ? '' : String(dashboardId);
    const existing = dashboardWindows.get(key);
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return { ok: true, reused: true };
    }

    const site = (store.settings().siteUrl || '').replace(/\/+$/, '');
    if (!site) {
        return { ok: false, error: 'No site URL configured.' };
    }

    const saved = usableBounds(store.dashboardWindow(key));
    const win = new BrowserWindow({
        ...(saved
            ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
            : { width: 1440, height: 900 }),
        title: 'LBCBot Dashboard',
        backgroundColor: '#0f1621',
        autoHideMenuBar: true,
        webPreferences: {
            partition: DASHBOARD_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true,
        },
    });
    if (saved && saved.maximized) {
        win.maximize();
    }
    dashboardWindows.set(key, win);

    const url = key
        ? `${site}/dashboard-view?dashboardId=${encodeURIComponent(key)}`
        // No id: land on the normal page so the user can pick one, then use its pop-out button.
        : `${site}/dashboard`;
    win.loadURL(url, { userAgent: DASHBOARD_USER_AGENT });

    win.webContents.setWindowOpenHandler(windowOpenPolicy);

    /*
     * Apply the same policy INSIDE the Twitch Backstage webview.
     *
     * A <webview> is its own webContents, so the host's handler above does not cover it — and the widget sets
     * `allowpopups`, which it needs because parts of Twitch's backstage (sign-in, some pickers) open a window.
     * Left alone, such a popup becomes an unmanaged BrowserWindow with DEFAULT webPreferences: no partition, so
     * a signed-out Twitch, which reads as "the embed made me log in again" for no visible reason.
     */
    win.webContents.on('did-attach-webview', (_event, guest) => {
        guest.setWindowOpenHandler(windowOpenPolicy);
    });

    // Persist geometry as it changes rather than only on close, so a crash or a forced quit does not lose it.
    const remember = debounce(() => {
        if (win.isDestroyed() || win.isMinimized()) return;
        const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
        store.saveDashboardWindow(key, { ...b, maximized: win.isMaximized(), open: true });
    }, 400);
    win.on('resize', remember);
    win.on('move', remember);
    win.on('maximize', remember);
    win.on('unmaximize', remember);

    win.on('close', () => {
        if (win.isDestroyed()) return;
        const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
        // open:false when the USER closed it, true when we are shutting down — that is the difference between
        // "don't bring this back" and "restore my layout next launch".
        store.saveDashboardWindow(key, { ...b, maximized: win.isMaximized(), open: isQuitting });
    });
    win.on('closed', () => {
        if (dashboardWindows.get(key) === win) {
            dashboardWindows.delete(key);
        }
    });

    log(`Opened dashboard window at ${url}`);
    return { ok: true };
}

/** Twitch's own UI (the Stream Together backstage), in-app on the dashboard's logged-in partition. */
let twitchWindow = null;

function openTwitchWindow(target) {
    const url = target || 'https://dashboard.twitch.tv/';
    if (twitchWindow && !twitchWindow.isDestroyed()) {
        twitchWindow.focus();
        twitchWindow.loadURL(url, { userAgent: DASHBOARD_USER_AGENT });
        return { ok: true, reused: true };
    }
    twitchWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        title: 'Twitch',
        backgroundColor: '#0e0e10',
        autoHideMenuBar: true,
        webPreferences: {
            partition: DASHBOARD_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    twitchWindow.loadURL(url, { userAgent: DASHBOARD_USER_AGENT });
    twitchWindow.on('closed', () => { twitchWindow = null; });
    return { ok: true };
}

/** Trailing debounce. Resize and move fire per frame; writing settings.json that often would be absurd. */
function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
}

function buildServices() {
    lbcbot = new LbcBot({ onLog: log });

    obs = new ObsBridge({
        onLog: log,
        onStatus: (status) => send('obs-status', status),
        onObsEvent: async (event) => {
            // OBS -> LBCBot. Fire and forget: a failed post must not stall the OBS event stream, and the user will
            // see it in the log.
            const result = await lbcbot.postObsEvent(event);
            if (!result.ok) {
                log(`Could not forward ${event.eventType}: ${result.error || result.status}`);
            }
        },
    });
}

/** LBCBot -> OBS. Started once there is a credential, and restarted whenever one is obtained. */
async function startDeviceControl() {
    const started = await lbcbot.startDeviceControl((command) => obs.execute(command));
    if (!started) {
        log('Not listening for OBS commands yet — connect to LBCBot first.');
    }
}

async function pushState() {
    send('state', {
        settings: store.settings(),
        lbcbotConnected: store.hasCredential(),
        obsConnected: obs ? obs.connected : false,
        userId: lbcbot ? lbcbot.userId : null,
        hasObsPassword: Boolean(store.getObsPassword()),
    });
}

function registerIpc() {
    ipcMain.handle('get-state', async () => {
        await pushState();
        return { settings: store.settings(), logLines };
    });

    ipcMain.handle('update-settings', async (_event, patch) => {
        const updated = store.update(patch);
        await pushState();
        return updated;
    });

    ipcMain.handle('set-obs-password', async (_event, password) => {
        store.setObsPassword(password || null);
        await pushState();
        return true;
    });

    ipcMain.handle('connect-lbcbot', async () => {
        try {
            const ok = await lbcbot.connect({
                onCode: (grant) => {
                    log(`Approve code ${grant.userCode} in your browser.`);
                    send('device-code', grant);
                },
            });
            if (ok) {
                log('Connected to LBCBot.');
                await startDeviceControl();
            } else {
                log('LBCBot connection was not approved before the code expired.');
            }
            await pushState();
            return ok;
        } catch (error) {
            log(`Connection failed: ${error.message}`);
            return false;
        }
    });

    ipcMain.handle('disconnect-lbcbot', async () => {
        lbcbot.disconnect();
        log('Forgot the LBCBot credential locally. It is NOT revoked — do that under Connected apps on the website.');
        await pushState();
        return true;
    });

    ipcMain.handle('connect-obs', async () => {
        const ok = await obs.connect();
        await pushState();
        return ok;
    });

    ipcMain.handle('disconnect-obs', async () => {
        await obs.disconnect();
        await pushState();
        return true;
    });

    ipcMain.handle('get-overlays', async () => {
        const result = await lbcbot.getOverlays();
        return result.ok ? result.data : [];
    });

    ipcMain.handle('get-scenes', async () => obs.getSceneList());

    /** Open (or focus) the dashboard window. `dashboardId` is optional — without it the picker page loads. */
    ipcMain.handle('open-dashboard', async (_event, dashboardId) => openDashboardWindow(dashboardId));

    /** The dashboards this user has, so the renderer can offer them by name rather than by id. */
    ipcMain.handle('get-dashboards', async () => {
        const result = await lbcbot.getDashboards();
        return result.ok ? result.data : [];
    });

    /**
     * One-click overlay setup: mint a scoped overlay key, build the component-view URL, and hand it straight to OBS.
     * The URL is never shown or copied anywhere.
     */
    ipcMain.handle('add-overlay-to-obs', async (_event, { overlayId, overlayName, sceneName, width, height }) => {
        if (!obs.connected) {
            return { ok: false, error: 'Not connected to OBS.' };
        }
        const key = await lbcbot.createOverlayKey(overlayId, `OBS browser source - ${overlayName || overlayId}`);
        if (!key.ok || !key.data || !key.data.credential) {
            return { ok: false, error: 'Could not create an overlay key.' };
        }

        // Same base64 `data` packing the browser builds, so the component view parses it with no special case.
        const payload = Buffer.from(JSON.stringify({ key: key.data.credential, overlayId })).toString('base64');
        const siteUrl = (store.settings().siteUrl || 'https://lbcbot.devsoperative.com').replace(/\/+$/, '');
        const url = `${siteUrl}/component-view?isComponentView=true&componentType=OVERLAY&data=${payload}`;

        try {
            const result = await obs.createBrowserSource({
                sceneName,
                inputName: `LBCBot - ${overlayName || overlayId}`,
                url,
                width,
                height,
            });
            log(`${result.created ? 'Created' : 'Updated'} browser source "${result.inputName}" in "${result.sceneName}".`);
            return { ok: true, ...result };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });
}

app.whenReady().then(async () => {
    buildServices();
    registerIpc();
    createWindow();

    const settings = store.settings();
    if (store.hasCredential()) {
        await lbcbot.token();
        await startDeviceControl();
    }
    if (settings.autoConnectObs) {
        await obs.connect();
    }
    await pushState();

    /*
     * Restore the dashboard layout: every window that was still open at the last quit, back at its own saved
     * position and size. Starting the app is then the whole setup step.
     *
     * Deliberately after the credential and OBS work above, so a slow token exchange does not delay the
     * windows appearing — they load the hosted site with their own session and do not depend on either.
     */
    const reopen = store.dashboardsToReopen();
    reopen.forEach((id) => openDashboardWindow(id === '' ? null : id));
    if (reopen.length) {
        log(`Reopened ${reopen.length} dashboard window${reopen.length === 1 ? '' : 's'}.`);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Distinguishes "the user closed this dashboard" from "the app is shutting down with it open" — the two mean
// opposite things for whether it should come back next launch. See the window's close handler.
app.on('before-quit', () => {
    isQuitting = true;
});

// The bridge is only useful while running, and a streamer closing the window means they are done with it — so quit
// rather than lingering. (A tray-resident mode is the obvious later refinement.)
app.on('window-all-closed', () => {
    if (obs) {
        obs.disconnect();
    }
    if (lbcbot) {
        lbcbot.stopDeviceControl();
    }
    app.quit();
});
