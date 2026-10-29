'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, screen, session, desktopCapturer, systemPreferences } = require('electron');
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
// The LBCBot helmet, the same mark as the website's logo and tab icon. Every window passes it so the title bar and
// taskbar show it in a dev run too; a packaged build also stamps it into the .exe and shortcuts (build/icon.png).
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');

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
        icon: APP_ICON,
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

/**
 * An INVISIBLE call client may never switch on the camera, microphone or screen share. A visible one may.
 *
 * <p>Electron grants permission requests by default when no handler is set, so without this a hidden
 * {@code <webview>} could start capturing with nothing on screen to show it. A blanket refusal is wrong
 * too: a streamer may legitimately want to talk, listen and share their screen through the call embedded in
 * the card, and denying media everywhere would quietly make that impossible.
 *
 * <p>So the split is by intent, read off the requesting URL. The Stream Together card marks a presence-only
 * client with {@code lbcbot=presence} (see the web app's `guestStarBridge`), and only that one is refused.
 * A call the streamer can see keeps its devices.
 *
 * <p>Presence itself needs no devices: a real session ran 9+ minutes with the host's audio and video both
 * reported unavailable, so refusing media costs a presence-only client nothing.
 *
 * <p>Everything other than capture keeps Electron's default answer, so a future card wanting clipboard or
 * notifications is not silently broken.
 */
const CAPTURE_PERMISSIONS = new Set(['media', 'audioCapture', 'videoCapture', 'display-capture', 'mediaKeySystem']);

/** Matches the marker the web app appends to a presence-only call client's URL. */
const PRESENCE_MARKER = /[?&]lbcbot=presence(?:&|$)/;

/** Opens System Settings directly on the Screen Recording list, rather than at its front door. */
const SCREEN_RECORDING_PANE =
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * Tell the user, in a dialog they cannot miss, that macOS is blocking screen share — and take them there.
 *
 * <p><b>Why a dialog and not just a log line.</b> Pressing "Share your screen" previously did nothing
 * visible: the handler refused and wrote to a console nobody has open. The permission cannot be granted or
 * even requested in code (see the caller), so the only honest design is to say so at the moment of the
 * press and make the fix one click away.
 *
 * <p><b>Why macOS cannot simply be asked.</b> Verified on macOS 12.7.4 / Electron 43:
 * `getMediaAccessStatus('screen')` is `CGPreflightScreenCaptureAccess()`, a bool with no "not determined"
 * state; `askForMediaAccess` covers camera and microphone only; and `desktopCapturer.getSources` throws
 * "Failed to get sources." rather than prompting — **even with the TCC record cleared via
 * `tccutil reset ScreenCapture`**, which was tested explicitly. macOS raises its own prompt only when a
 * capture actually starts, and a capture cannot start without a source, which needs the permission. So a
 * one-time prompt that has already been answered never returns, and the grant is manual by construction.
 *
 * <p>The second button exists because the grant is applied at LAUNCH: enabling it while the app runs changes
 * nothing until a restart, which is the step people skip and then report the feature as broken.
 */
async function offerScreenRecordingAccess() {
    if (process.platform !== 'darwin') return;
    /*
     * Unpackaged, the row macOS lists is Electron's own bundle, not ours — naming the wrong one sends the
     * user scanning a list that really does contain the entry they need.
     */
    const tccName = app.isPackaged ? 'LBCBot' : 'Electron';
    const parent = BrowserWindow.getFocusedWindow() || undefined;
    const { response } = await dialog.showMessageBox(parent, {
        type: 'warning',
        buttons: ['Open Screen Recording Settings', 'I enabled it — relaunch', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'macOS is blocking screen sharing',
        detail: `To share your screen, macOS needs Screen Recording permission for "${tccName}".\n\n`
            + `1. Open the settings below and switch on "${tccName}" (use + to add it if it is missing).\n`
            + '2. Relaunch LBCBot — macOS only applies this permission when the app starts.\n\n'
            + 'macOS cannot be prompted for this from inside the app, and it only ever asks once, '
            + 'so this has to be switched on by hand.',
    });
    if (response === 0) {
        shell.openExternal(SCREEN_RECORDING_PANE).catch((error) => {
            log(`Could not open Screen Recording settings: ${(error && error.message) || error}`);
        });
        return;
    }
    if (response === 1) {
        log('Relaunching to pick up the Screen Recording permission.');
        app.relaunch();
        app.quit();
    }
}

/**
 * Screen sharing, which does not work in Electron unless the app provides the source itself.
 *
 * <p>A page calling `getDisplayMedia()` — Twitch's "Share your screen" in the embedded Stream Together call,
 * for instance — is refused outright when no handler is registered. There was none, so that button could
 * never have worked in this app, in the card or anywhere else.
 *
 * <p>The choice is the user's, so this shows a chooser rather than granting a screen automatically: handing
 * a call the whole desktop because someone clicked "share" is how the wrong window ends up on stream.
 * macOS's own picker (`useSystemPicker`) would be simpler but needs a newer macOS than this app targets.
 *
 * <p>Closing the chooser without picking calls back with nothing, which is how Electron spells "denied".
 */
let pickerWindow = null;
let pickerSources = [];
let pickerResolve = null;

function chooseShareSource(sources) {
    return new Promise((resolve) => {
        pickerSources = sources;
        pickerResolve = resolve;
        pickerWindow = new BrowserWindow({
            icon: APP_ICON,
            width: 780,
            height: 540,
            title: 'Share your screen',
            backgroundColor: '#15161a',
            autoHideMenuBar: true,
            webPreferences: {
                preload: path.join(__dirname, '..', 'preload', 'picker.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        pickerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'picker.html'));
        pickerWindow.on('closed', () => {
            pickerWindow = null;
            // Dismissed without choosing: resolve to nothing so the caller denies rather than hangs.
            if (pickerResolve) {
                pickerResolve(null);
                pickerResolve = null;
            }
        });
    });
}

function registerPickerIpc() {
    ipcMain.handle('picker-sources', () => pickerSources.map((source) => ({
        id: source.id,
        name: source.name,
        thumb: source.thumbnail.toDataURL(),
    })));
    ipcMain.handle('picker-choose', (_event, id) => {
        const chosen = pickerSources.find((source) => source.id === id) || null;
        if (pickerResolve) {
            pickerResolve(chosen);
            pickerResolve = null;
        }
        if (pickerWindow && !pickerWindow.isDestroyed()) {
            pickerWindow.close();
        }
        return true;
    });
}

function applyPermissionPolicy() {
    const s = session.fromPartition(DASHBOARD_PARTITION);
    const presenceOnly = (contents, details) => {
        const url = (details && details.requestingUrl) || (contents && !contents.isDestroyed() && contents.getURL()) || '';
        return PRESENCE_MARKER.test(url);
    };
    s.setPermissionRequestHandler((contents, permission, callback, details) => {
        if (CAPTURE_PERMISSIONS.has(permission) && presenceOnly(contents, details)) {
            log(`Denied ${permission}: presence-only call client has no devices by design`);
            callback(false);
            return;
        }
        callback(true);
    });
    // The request handler covers prompts; this covers the synchronous checks a page makes before asking.
    s.setPermissionCheckHandler((contents, permission, _origin, details) => !(
        CAPTURE_PERMISSIONS.has(permission) && presenceOnly(contents, details)
    ));

    s.setDisplayMediaRequestHandler(async (request, callback) => {
        const url = (request && request.frame && request.frame.url) || '';
        if (PRESENCE_MARKER.test(url)) {
            log('Denied screen share: presence-only call client has no devices by design');
            callback();
            return;
        }
        try {
            /*
             * macOS gates screen capture behind a SYSTEM permission that nothing in this app can grant,
             * and — unlike camera and microphone — nothing in this app can even ASK for.
             *
             * `getMediaAccessStatus('screen')` is backed by `CGPreflightScreenCaptureAccess()`, a bool, so
             * on macOS it only ever answers 'granted' or 'denied': there is no 'not-determined' to fall
             * through on, and `askForMediaAccess` covers camera/microphone only. Verified on macOS 12.7.4 /
             * Electron 43: with status 'denied', `getSources` does NOT raise the system prompt, it throws
             * "Failed to get sources." So there is no programmatic path to the grant at all — the user has
             * to add the app in System Settings by hand. Short-circuit and say so precisely.
             */
            const screenAccess = process.platform === 'darwin'
                ? systemPreferences.getMediaAccessStatus('screen')
                : 'granted';
            if (screenAccess !== 'granted') {
                log(`Screen share is blocked (screen access is "${screenAccess}").`);
                await offerScreenRecordingAccess();
                callback();
                return;
            }
            const sources = await desktopCapturer.getSources({
                types: ['screen', 'window'],
                thumbnailSize: { width: 320, height: 180 },
            });
            if (!sources.length) {
                /*
                 * Preflight said granted, yet there is nothing to capture — on macOS that almost always
                 * means the permission was switched on while this process was already running, and the
                 * grant only takes effect at launch. Same dialog: its second button is the relaunch.
                 */
                log('Nothing to share — Screen Recording was most likely granted after launch.');
                await offerScreenRecordingAccess();
                callback();
                return;
            }
            const chosen = await chooseShareSource(sources);
            if (!chosen) {
                log('Screen share cancelled.');
                callback();
                return;
            }
            log(`Sharing "${chosen.name}".`);
            callback({ video: chosen });
        } catch (error) {
            // Not every rejection here is an Error; Electron can reject with a bare string.
            log(`Screen share failed: ${(error && error.message) || String(error)}`);
            callback();
        }
    });
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
const pathOf = (target) => {
    try {
        return new URL(target).pathname.replace(/\/+$/, '') || '/';
    } catch {
        return null;
    }
};
/** Our own pages that open in the system browser rather than in-app. Must match routes.SONG_PLAYER in the web app. */
const EXTERNAL_PATHS = ['/song-player'];

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
    /*
     * Pages of ours that must NOT run in here: the song player. YouTube serves ads to any plain Chromium, this app
     * included, and the streamer's YouTube Premium login or ad blocker lives in their own browser — which an app
     * cannot borrow or embed. So the Media Queue card's "Your browser" opens the player in the system browser.
     */
    if (ours && EXTERNAL_PATHS.includes(pathOf(target))) {
        shell.openExternal(target);
        return { action: 'deny' };
    }
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
    // A dashboard card's "Sign in to Twitch" button. Opened as THE sign-in window, so it closes itself and every
    // card reloads the moment Twitch accepts the login (see watchTwitchSessionCookie).
    if (/^https:\/\/www\.twitch\.tv\/login\/?(\?|$)/i.test(target || '')) {
        openTwitchSignIn();
        return { action: 'deny' };
    }
    if (/^https:\/\/([a-z0-9-]+\.)*twitch\.tv(\/|$)/i.test(target || '')) {
        openTwitchWindow(target);
        return { action: 'deny' };
    }
    if (/^https?:\/\//i.test(target || '')) {
        shell.openExternal(target);
        return { action: 'deny' };
    }
    /*
     * A popup with no destination yet — `window.open()`, `window.open('')`, `window.open('about:blank')` —
     * which the opener then navigates or writes into itself. Denying one is INVISIBLE: the opener gets `null`
     * back from window.open and, if it does not check, simply does nothing. That is indistinguishable from a
     * dead button, and it is the shape Twitch's backstage uses for some of its panels.
     *
     * Allowed, because a blank popup carries nothing to vet: it can only ever be driven by the page that
     * opened it, and every page that can reach this handler is already one we host. It inherits the dashboard
     * partition for the same reason the auth popups do — a signed-out window here reads as a broken embed.
     */
    if (!host) {
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                width: 1100,
                height: 820,
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
    // Reached only by a non-http(s) scheme we do not handle. Logged because a silently-dropped window open is
    // otherwise unobservable from inside the app, and "I clicked it and nothing happened" is the only symptom.
    log(`Blocked window open: ${target}`);
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
async function openDashboardWindow(dashboardId) {
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

    /*
     * Refuse to open a dashboard this app cannot sign in.
     *
     * The window seeds this machine's credential into the page so it logs itself in. With no usable
     * credential the page falls through to the PUBLIC LANDING PAGE — a marketing page with a "Connect with
     * Twitch" button, inside a frameless window, which reads as the app being broken. Better to say what is
     * wrong where the user can fix it.
     *
     * Presence of a credential is not the test, and that distinction is the whole point: a credential minted
     * against a different API is present and useless (exactly what happens when `apiUrl` is switched). So
     * this asks for a TOKEN, which is the only thing that proves the credential is accepted by the API this
     * app is pointed at.
     */
    if (!store.hasCredential()) {
        return { ok: false, error: 'Connect this app to LBCBot first — see the Status pane.' };
    }
    if (!await lbcbot.token()) {
        return { ok: false, error: 'LBCBot would not accept this machine\'s credential. Reconnect in the Status pane.' };
    }

    const saved = usableBounds(store.dashboardWindow(key));
    const win = new BrowserWindow({
        icon: APP_ICON,
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
            // Seeds this machine's credential into localStorage so the page signs itself in instead of showing a
            // web login nobody can complete in an embedded window. Exposes NO api surface — see the file.
            preload: path.join(__dirname, '..', 'preload', 'dashboard.js'),
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

    /*
     * Recover a dashboard whose page cannot recover itself.
     *
     * The page heals its own cards, socket and session after a sleep, but only while it is running. If its
     * renderer dies (killed across a sleep, out of memory, a crash) the window is blank and nothing in it can
     * notice; if a load fails (offline at launch, or at a reload) it sits on Chromium's error page. Either way,
     * load it again: it signs itself back in from the credential and rebuilds every card. A renderer that keeps
     * dying is retried slowly, so a page that crashes on load cannot spin.
     */
    let lastCrashReload = 0;
    win.webContents.on('render-process-gone', (_event, details) => {
        const reason = (details && details.reason) || 'unknown';
        log(`Dashboard renderer gone (${reason}) — reloading.`);
        if (win.isDestroyed() || reason === 'clean-exit') return;
        const wait = Date.now() - lastCrashReload < 60000 ? 15000 : 1000;
        lastCrashReload = Date.now();
        setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, wait);
    });
    win.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
        // -3 is ABORTED: one navigation superseding another, not a failure.
        if (!isMainFrame || code === -3) return;
        log(`Dashboard failed to load (${description || code}) — retrying in 10s.`);
        setTimeout(() => { if (!win.isDestroyed()) win.loadURL(failedUrl || url); }, 10000);
    });

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
        watchBackstageSignIn(guest);
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

/**
 * Reload every open dashboard so each re-runs its preload and picks up the current credential.
 *
 * Called when the credential CHANGES — connect and disconnect — because a dashboard decides whether it has a
 * session once, during page startup. Without this, connecting leaves every already-open window stranded on the
 * signed-out page until it is closed and reopened, which looks like connecting did not work.
 */
function reloadDashboards() {
    dashboardWindows.forEach((win) => {
        if (!win.isDestroyed()) {
            win.webContents.reload();
        }
    });
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
        icon: APP_ICON,
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
    watchForIntegrityRejection(twitchWindow.webContents);
    twitchWindow.loadURL(url);
    twitchWindow.on('closed', () => {
        twitchWindow = null;
        twitchSignInPending = false;
    });
    return { ok: true };
}

/**
 * Twitch sign-in for the backstage widget happens in the Twitch window, not in the `<webview>`'s inline form.
 *
 * <h3>The "browser not supported" failure, and what actually causes it</h3>
 *
 * Twitch answers a refused login with passport `error_code: 5025` and logs "Browser not supported - integrity
 * error". Despite the wording it is not about the UA: with the same Electron, UA, client hints and partition, a
 * login failed against one partition and succeeded against a fresh one. What differed was Twitch's DEVICE state
 * on .twitch.tv — the `unique_id` device cookie and integrity storage — which builds that announced a stale
 * Chrome had accumulated failed attempts against. Twitch keeps refusing that device; clearing its Twitch data
 * makes it a new device, and the login goes through (verified on Windows, Electron 43). See
 * {@link watchForIntegrityRejection}, which does that clear automatically.
 *
 * <h3>Why a separate window at all</h3>
 *
 * Signed out, dashboard.twitch.tv renders its login inline with no navigation to hook, and a login form squeezed
 * into a dashboard card is a poor place to type a password and a 2FA code. So a signed-out backstage opens the
 * Twitch window instead. It shares the partition, so the `auth-token` cookie it earns is the embed's too; the
 * cookie watcher then closes that window and reloads the embeds, which come back signed in.
 */
const TWITCH_AUTH_COOKIE = 'auth-token';
/*
 * The sign-in page: LBCBot's OAuth authorize URL, which redirects to Twitch's login.
 *
 * This is the path verified end to end on a clean device, and it leaves the same full `auth-token` web session on
 * .twitch.tv as any Twitch login — all the backstage needs. The cookie lands the moment the password is accepted,
 * before the consent screen, and the cookie watcher closes the window right then, so nothing is authorized here.
 */
const TWITCH_LBCBOT_CLIENT_ID = 'si19qnvsuhkwcm97xwoonntwz36bq9';
const TWITCH_LOGIN_URL = 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
    client_id: TWITCH_LBCBOT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: 'https://lbcbot.devsoperative.com/auth',
    scope: 'user:read:email',
    force_verify: 'true',
    state: 'desktop-backstage-signin',
}).toString();

/** Set once the Twitch device data has been reset this run, so a login that still fails cannot loop the reset. */
let twitchDeviceReset = false;

/** Forget this partition's Twitch device: every .twitch.tv cookie and the storage of Twitch's own origins. */
async function clearTwitchDeviceData() {
    const s = session.fromPartition(DASHBOARD_PARTITION);
    const cookies = (await s.cookies.get({})).filter((c) => /(^|\.)twitch\.tv$/i.test((c.domain || '').replace(/^\./, '')));
    await Promise.all(cookies.map((c) => s.cookies
        .remove(`https://${c.domain.replace(/^\./, '')}${c.path || '/'}`, c.name)
        .catch(() => {})));
    const origins = ['www.twitch.tv', 'dashboard.twitch.tv', 'id.twitch.tv', 'passport.twitch.tv', 'gql.twitch.tv', 'm.twitch.tv'];
    await Promise.all(origins.map((o) => s.clearStorageData({ origin: `https://${o}` }).catch(() => {})));
    await s.flushStorageData();
}

/**
 * Recover from Twitch refusing this device: on its "integrity error", reset the device once and retry sign-in.
 *
 * Twitch's login page logs the refusal to its console ("Browser not supported - integrity error"), which is the
 * one place it is readable from here — the passport response body is not visible to webRequest. Once per app run:
 * if a fresh device is refused too, the cause is something else and repeating the reset would only loop.
 */
function watchForIntegrityRejection(contents) {
    contents.on('console-message', async (event, _level, legacyMessage) => {
        const message = (event && event.message) || legacyMessage || '';
        if (twitchDeviceReset || !/integrity error/i.test(message)) {
            return;
        }
        twitchDeviceReset = true;
        log('Twitch refused this device ("browser not supported"). Resetting its Twitch data and retrying sign-in.');
        await clearTwitchDeviceData();
        if (!contents.isDestroyed()) {
            contents.loadURL(TWITCH_LOGIN_URL);
        }
    });
}

/** Backstage webviews currently attached, so a completed sign-in can reload them all. */
const backstageGuests = new Set();

/** True while the Twitch window is open for a sign-in WE started, so only that window is closed afterwards. */
let twitchSignInPending = false;

async function twitchSignedIn() {
    const cookies = await session.fromPartition(DASHBOARD_PARTITION).cookies.get({
        domain: 'twitch.tv',
        name: TWITCH_AUTH_COOKIE,
    });
    return cookies.length > 0;
}

/**
 * Track a backstage webview so a completed sign-in can reload it.
 *
 * Deliberately does NOT open the sign-in window by itself. It used to, on every signed-out load, which put a
 * window on screen next to each card's own Twitch login form — several login forms, only one of which worked.
 * Now a signed-out card shows a single "Sign in to Twitch" button (frontend), and that click is the only thing
 * that opens the window (see windowOpenPolicy).
 */
function watchBackstageSignIn(guest) {
    backstageGuests.add(guest);
    guest.once('destroyed', () => backstageGuests.delete(guest));
}

/** The card's sign-in button: one window, focused if already open so a second click cannot wipe a half-typed login. */
function openTwitchSignIn() {
    if (twitchSignInPending && twitchWindow && !twitchWindow.isDestroyed()) {
        twitchWindow.focus();
        return;
    }
    log('Opening Twitch sign-in.');
    twitchSignInPending = true;
    openTwitchWindow(TWITCH_LOGIN_URL);
}

/**
 * Call once at startup: finishes a backstage sign-in the moment Twitch hands the partition its session cookie.
 *
 * Acts only on the signed-out → signed-in edge. Twitch rewrites `auth-token` while already signed in, and
 * reloading every backstage on each rewrite would loop a streamer's embed mid-stream.
 */
function watchTwitchSessionCookie() {
    let signedIn = true; // Assume signed in until checked, so a rewrite during the check cannot trigger a reload.
    twitchSignedIn().then((value) => { signedIn = value; }, () => { signedIn = false; });
    session.fromPartition(DASHBOARD_PARTITION).cookies.on('changed', (_event, cookie, cause, removed) => {
        if (cookie.name !== TWITCH_AUTH_COOKIE || !/(^|\.)twitch\.tv$/i.test(cookie.domain || '')) {
            return;
        }
        // An overwrite arrives as a removal (cause "overwrite") followed by an add — still signed in throughout.
        // Any other removal is a real sign-out or expiry.
        if (removed) {
            if (!/overwrite/.test(cause)) {
                signedIn = false;
            }
            return;
        }
        if (signedIn) {
            return;
        }
        signedIn = true;
        log('Signed in to Twitch — reloading the backstage.');
        if (twitchSignInPending && twitchWindow && !twitchWindow.isDestroyed()) {
            twitchWindow.close();
        }
        twitchSignInPending = false;
        backstageGuests.forEach((guest) => {
            if (!guest.isDestroyed()) {
                guest.reload();
            }
        });
    });
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
    /*
     * The dashboard preload asking for this machine's credential.
     *
     * Synchronous because the preload has to answer before the page's own scripts run — the page reads the
     * credential during startup, and an async hand-off would race that and work only sometimes.
     *
     * The sender is checked against our own dashboard windows even though the remote page cannot reach
     * `ipcRenderer` (contextIsolation is on and the preload exposes nothing): this channel hands out a full-scope
     * credential, so it should be unreachable by construction rather than by relying on one setting staying put.
     */
    ipcMain.on('dashboard-credential', (event) => {
        const fromDashboard = [...dashboardWindows.values()].some(
            (win) => !win.isDestroyed() && win.webContents.id === event.sender.id,
        );
        event.returnValue = fromDashboard ? store.getCredential() : null;
    });

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
                // Any dashboard already open is sitting on the signed-out page, because it was opened before
                // there was a credential to seed. The preload runs again on reload, so this is what turns
                // "connect" into "my dashboards are signed in" without the user closing and reopening them.
                reloadDashboards();
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
        // Same reason as on connect, in the other direction: a dashboard left open would keep a session the
        // machine no longer has a credential for, which is exactly what "disconnect" should not leave behind.
        reloadDashboards();
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
    // The keychain only answers once the app is ready, and every credential read below is served from what this loads.
    await store.load();
    buildServices();
    registerIpc();
    // Before any window on the dashboard partition exists — a session UA does not reach WebContents that already
    // do. See applySessionUserAgent.
    applySessionUserAgent();
    // Same timing requirement, same reason: a handler set after a WebContents exists does not govern it.
    applyPermissionPolicy();
    registerPickerIpc();
    watchTwitchSessionCookie();
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
    if (reopen.length) {
        /*
         * Now awaited, where it used to be fire-and-forget. The note above about not delaying the windows
         * still holds in spirit, but a window that opens instantly onto a login page is worse than one that
         * waits for the token exchange — and when the credential is not accepted, not opening at all beats
         * reopening the whole layout onto landing pages.
         */
        const opened = await Promise.all(reopen.map((id) => openDashboardWindow(id === '' ? null : id)));
        const failed = opened.find((r) => r && r.ok === false);
        if (failed) {
            log(`Did not reopen dashboards: ${failed.error}`);
        } else {
            log(`Reopened ${reopen.length} dashboard window${reopen.length === 1 ? '' : 's'}.`);
        }
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
