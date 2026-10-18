'use strict';

const { app, BrowserWindow, ipcMain, shell, screen, session } = require('electron');
const path = require('node:path');
const store = require('./store');
const { LbcBot } = require('./lbcbot');
const { ObsBridge } = require('./obs');
const { Updater } = require('./updater');

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
let updater = null;

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
 * Our user agent: Electron's own default, with the Electron token removed and ours appended.
 *
 * <h3>Why this is DERIVED and never written out by hand</h3>
 *
 * It used to be a literal string claiming `Chrome/128.0.0.0`. Electron 43 ships Chromium **150**, so the app was
 * announcing a browser more than two years out of date, and Twitch's sign-in answered "Your browser is not
 * currently supported" — correctly, by its own rules. A hardcoded version is wrong the moment Electron is
 * upgraded and silently rots from there; taking Electron's default means the Chrome version is always the one
 * actually rendering the page, and the platform token is always the real platform rather than a Mac string
 * shipped to Windows users.
 *
 * <h3>The client-hint half, which a UA string cannot fix</h3>
 *
 * `setUserAgent` does not touch `navigator.userAgentData` or the `Sec-CH-UA` headers — those keep reporting the
 * real Chromium build. Hardcoding therefore also produced a contradiction (UA said 128, client hints said 150),
 * which is exactly the inconsistency browser-integrity checks look for. Deriving from the default makes the two
 * agree by construction, so there is nothing left to spoof. Electron's client-hint brands are "Chromium" and
 * "Not;A=Brand" — no Electron brand leaks — so with the versions in step this reads as ordinary Chrome.
 *
 * <h3>Why the trailing token stays</h3>
 *
 * `LBCBotDesktop/1.0` is how the WEB APP detects it is running inside the desktop app, which is what lets a
 * widget render a live `<webview>` embed here and a plain "open in a tab" button in a browser. Sniffing for
 * "Electron" would have worked until the moment that token was removed, so the two needs are solved together.
 */
function buildUserAgent() {
    const base = app.userAgentFallback || '';
    const chromeLike = base
        // "Electron/43.8.0" — the part sign-in flows challenge.
        .replace(/\sElectron\/[\d.]+/i, '')
        // A product token Electron inserts before Chrome when the app has a name ("LBCBot/1.0.3 Chrome/150…").
        // Scoped by the lookahead so it can only ever remove the token directly in front of Chrome.
        .replace(/\s[^\s/]+\/[\d.]+(?=\sChrome\/)/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return `${chromeLike} LBCBotDesktop/1.0`;
}

/** Resolved once at startup, after `app` is ready enough to know its own default. */
let DASHBOARD_USER_AGENT = '';

/**
 * Pin the user agent app-wide, not on each navigation.
 *
 * `loadURL(url, { userAgent })` applies to that one navigation and nothing after it. A sign-in is a chain of
 * navigations — the authorize page, the form POST, the redirect back — and every step after the first went out
 * with Electron's default UA, Electron token and all. Setting `userAgentFallback` covers every session and every
 * window, including ones added later that nobody remembers to wire up; the partition is set explicitly too, since
 * that is the session the dashboards and the Twitch window actually use.
 *
 * Call before creating any window: Electron's own note is that a session UA does not affect WebContents that
 * already exist.
 */
function applySessionUserAgent() {
    DASHBOARD_USER_AGENT = buildUserAgent();
    app.userAgentFallback = DASHBOARD_USER_AGENT;
    session.fromPartition(DASHBOARD_PARTITION).setUserAgent(DASHBOARD_USER_AGENT);
    log(`Browser identity: ${DASHBOARD_USER_AGENT}`);
}

/** Open dashboard windows, keyed by dashboardId (the string '' stands for the no-id picker window). */
const dashboardWindows = new Map();

/** The hosts an OAuth consent screen actually lives on, for the flows this app's dashboards can start. */
const AUTH_HOSTS = /^(id\.twitch\.tv|accounts\.google\.com|accounts\.spotify\.com)$/i;

const hostOf = (target) => {
    try {
        return new URL(target).host;
    } catch {
        return null;
    }
};

/** The configured site's own host, so the OAuth callback leg is recognised as ours rather than as a stray link. */
const siteHost = () => hostOf((store.settings().siteUrl || '').replace(/\/+$/, '') || 'about:blank');

/**
 * Where a link is allowed to open.
 *
 * Three outcomes, and the first one is the whole reason this is not a two-liner:
 *
 * <ol>
 *   <li><b>A sign-in popup opens as a real popup.</b> The web app's OAuth flow opens a window, lets the provider
 *       redirect it back to `/auth?code=…`, and the callback page relays the code to `window.opener` by
 *       postMessage before closing itself. Denying the open and hand-rolling a BrowserWindow — which this did —
 *       produces a window with <b>no opener</b>, so the code has nowhere to go: the user signs in successfully,
 *       the popup sits on the landing page, and the dashboard behind it never learns anything happened. Allowing
 *       the open keeps the opener intact and the flow works. The override only pins the partition, so the popup
 *       shares the session it is signing in to.</li>
 *   <li><b>Other Twitch links stay in-app.</b> Twitch's backstage is the reason for being here — bouncing it to
 *       the system browser would mean a second login and lose the point.</li>
 *   <li><b>Everything else leaves.</b> A docs link must not replace the control surface a streamer is using
 *       mid-stream.</li>
 * </ol>
 */
const windowOpenPolicy = ({ url: target }) => {
    const host = hostOf(target || '');
    const ours = host && host === siteHost();
    if (host && (AUTH_HOSTS.test(host) || ours)) {
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                // A consent screen is a tall narrow popup; a page of ours is a page. Sizing a `target="_blank"`
                // link to our own site like a sign-in box would open the rewards editor in a 520px column.
                ...(ours
                    ? { width: 1200, height: 860, title: 'LBCBot' }
                    : { width: 520, height: 760, title: 'Sign in' }),
                backgroundColor: '#0e0e10',
                autoHideMenuBar: true,
                webPreferences: {
                    partition: DASHBOARD_PARTITION,
                    contextIsolation: true,
                    nodeIntegration: false,
                },
            },
        };
    }
    if (/^https:\/\/([a-z0-9-]+\.)*twitch\.tv\//i.test(target || '')) {
        openTwitchWindow(target);
        return { action: 'deny' };
    }
    if (/^https?:\/\//i.test(target || '')) {
        shell.openExternal(target);
    }
    return { action: 'deny' };
};

/**
 * Carry the policy and the UA onto a window Electron created for us.
 *
 * A popup allowed above is a fresh webContents with no handler of its own, so a second `window.open` from inside
 * the consent screen would land with default preferences and no partition — a signed-out window appearing
 * mid-sign-in. The UA is re-set here as well because the session-level value does not reach a webContents that
 * was already being constructed when it was applied.
 */
function adoptChildWindow(contents) {
    // Guarded because an empty string would REPLACE the inherited fallback with nothing, which is worse than
    // doing nothing at all. It is only empty before applySessionUserAgent has run, which no window outlives.
    if (DASHBOARD_USER_AGENT) {
        contents.setUserAgent(DASHBOARD_USER_AGENT);
    }
    contents.setWindowOpenHandler(windowOpenPolicy);
}

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
    // The UA comes from the session (see applySessionUserAgent) so it survives every later navigation; it is set
    // on this webContents too because the session value does not reach one already under construction.
    win.webContents.setUserAgent(DASHBOARD_USER_AGENT);
    win.loadURL(url);

    win.webContents.setWindowOpenHandler(windowOpenPolicy);
    win.webContents.on('did-create-window', (child) => adoptChildWindow(child.webContents));

    /*
     * Apply the same policy INSIDE the Twitch Backstage webview.
     *
     * A <webview> is its own webContents, so the host's handler above does not cover it — and the widget sets
     * `allowpopups`, which it needs because parts of Twitch's backstage (sign-in, some pickers) open a window.
     * Left alone, such a popup becomes an unmanaged BrowserWindow with DEFAULT webPreferences: no partition, so
     * a signed-out Twitch, which reads as "the embed made me log in again" for no visible reason.
     */
    win.webContents.on('did-attach-webview', (_event, guest) => {
        adoptChildWindow(guest);
        guest.on('did-create-window', (child) => adoptChildWindow(child.webContents));
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
        twitchWindow.loadURL(url);
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
    // Twitch's own sign-in runs here when the backstage asks for it, so this window needs the same sticky UA and
    // the same popup policy as a dashboard — it is the window most likely to be told "browser not supported".
    adoptChildWindow(twitchWindow.webContents);
    twitchWindow.webContents.on('did-create-window', (child) => adoptChildWindow(child.webContents));
    twitchWindow.loadURL(url);
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

    updater = new Updater({
        onLog: log,
        onStatus: (status) => send('update-status', status),
    });

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
        // The update status is returned rather than only pushed: a check can finish before the renderer has
        // mounted, and an update that is ready to install must not be invisible until the next six-hour tick.
        return { settings: store.settings(), logLines, update: updater.status, version: app.getVersion() };
    });

    ipcMain.handle('check-for-updates', async () => {
        updater.check();
        return updater.status;
    });

    ipcMain.handle('restart-for-update', async () => updater.restartAndInstall());

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

    /** Linked streaming platforms (Twitch / YouTube / Spotify) for this account. */
    ipcMain.handle('get-platforms', async () => {
        const result = await lbcbot.getPlatforms();
        return result.ok ? result.data : null;
    });

    /**
     * Send the user to the website to link or unlink a platform.
     *
     * Deliberately the site's own Integrations page rather than building the OAuth URL here. That URL needs the
     * provider client ids and the exact scope list, which live in the frontend's runtime config and change —
     * duplicating them into a shipped desktop binary means a stale copy that fails silently the next time a
     * scope is added, and an installed app is the hardest thing in the system to update.
     *
     * The system browser, not an app window: this is an OAuth consent screen, and consent should happen somewhere
     * the user can see the real address bar.
     */
    ipcMain.handle('open-integrations', async () => {
        const site = (store.settings().siteUrl || '').replace(/\/+$/, '');
        if (!site) {
            return { ok: false, error: 'No website URL configured.' };
        }
        await shell.openExternal(`${site}/integrations`);
        return { ok: true };
    });

    /* --------------------------------------------------------------- stream templates */

    ipcMain.handle('get-stream-templates', async () => {
        const result = await lbcbot.getStreamTemplates();
        return result.ok ? result.data : [];
    });

    ipcMain.handle('save-stream-template', async (_event, { id, template }) => {
        const result = await lbcbot.saveStreamTemplate(id, template);
        if (!result.ok) {
            log(`Could not save the template: ${result.error || result.status}`);
        }
        return result;
    });

    ipcMain.handle('delete-stream-template', async (_event, id) => {
        const result = await lbcbot.deleteStreamTemplate(id);
        if (!result.ok) {
            log(`Could not delete the template: ${result.error || result.status}`);
        }
        return result;
    });

    /**
     * Apply a template. The per-platform outcomes are logged as well as returned: the renderer shows them
     * inline, but "Twitch updated, YouTube skipped" is exactly the sort of thing worth being able to scroll
     * back to afterwards.
     */
    ipcMain.handle('apply-stream-template', async (_event, id) => {
        const result = await lbcbot.applyStreamTemplate(id);
        if (!result.ok) {
            log(`Could not apply the template: ${result.error || result.status}`);
            return result;
        }
        ['twitch', 'youtube'].forEach((platform) => {
            const outcome = result.data && result.data[platform];
            if (outcome && outcome.attempted) {
                log(`${platform}: ${outcome.message}`);
            }
        });
        return result;
    });

    ipcMain.handle('search-twitch-categories', async (_event, query) => {
        const result = await lbcbot.searchTwitchCategories(query);
        // The shape is Twitch's own { data: [ { id, name, box_art_url } ] }.
        return result.ok && result.data && Array.isArray(result.data.data) ? result.data.data : [];
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
    // Before any window on the dashboard partition exists — a session UA does not reach WebContents that already
    // do. See applySessionUserAgent.
    applySessionUserAgent();
    createWindow();
    updater.start();

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
    if (updater) {
        updater.stop();
    }
    if (obs) {
        obs.disconnect();
    }
    if (lbcbot) {
        lbcbot.stopDeviceControl();
    }
    app.quit();
});
