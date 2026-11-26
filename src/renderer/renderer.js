'use strict';

/* Renderer: status and settings only. It has no credential, no network access and no OBS or GreenSplit access —
   everything goes through the narrow bridge in src/preload/index.js. */

const el = (id) => document.getElementById(id);

const logEl = el('log');
const appendLog = (line) => {
    logEl.textContent += (logEl.textContent ? '\n' : '') + line;
    logEl.scrollTop = logEl.scrollHeight;
};

function setPill(node, on, onText, offText) {
    node.textContent = on ? onText : offText;
    node.className = `pill ${on ? 'pill--on' : 'pill--off'}`;
}

/**
 * Connection state, shown as a dot beside its pill in the sidebar.
 *
 * The pills live in the rail rather than in the Status pane so that connection state is readable from every
 * pane — the one piece of state that matters no matter what you are doing.
 */
function setStatus(name, on) {
    // "Online / Offline" rather than "Connected / Not connected": the rail is 200px, and the longer words wrapped
    // the pill onto two lines, then (with "GreenSplit" as a label) pushed it past the rail's edge. The dot carries
    // the same meaning anyway, so the word only has to confirm it. The cards say "Connected" in full.
    setPill(el(`${name}-status`), on, 'Online', 'Offline');
    el(`${name}-dot`).className = `dot ${on ? 'dot--on' : 'dot--off'}`;

    // Only offer what can happen now: Connect while offline, Disconnect while connected. (LBCBot's card offers its
    // accounts instead: renderAccounts.)
    if (name === 'obs') {
        el('obs-connect').hidden = !!on;
        el('obs-disconnect').hidden = !on;
    }

    /*
     * Mirror it onto the card that owns the action, where one exists.
     *
     * Here there is room for the full phrase, so it says "Not connected" rather than the rail's clipped
     * "Offline" — this is the line you read before deciding whether to press Connect.
     */
    const dot = el(`${name}-conn-dot`);
    const text = el(`${name}-conn-text`);
    if (dot && text) {
        dot.className = `dot ${on ? 'dot--on' : 'dot--off'}`;
        text.textContent = on ? 'Connected' : 'Not connected';
    }
}

/**
 * Sidebar navigation.
 *
 * Wired generically off `data-pane` so adding a section is one nav button and one `.pane` — nothing here needs
 * to learn its name. Deliberately not persisted: a launch should always open on Status, because that is where
 * you act when something failed to connect.
 */
/*
 * The lists each pane shows come from the account, so they are re-read when the pane is opened — the startup read
 * can happen before this machine has finished connecting, answer empty, and (before this) stay empty all session:
 * "No templates yet" with three templates on the website.
 */
const PANE_REFRESH = {
    templates: () => refreshTemplates(),
    overlays: () => refreshOverlays(),
    dashboards: () => refreshDashboards(),
    status: () => refreshPlatforms(),
};

function showPane(name) {
    const pane = el(`pane-${name}`);
    if (!pane) return;
    if (PANE_REFRESH[name]) PANE_REFRESH[name]();
    document.querySelectorAll('.pane').forEach((node) => {
        node.classList.toggle('is-active', node === pane);
    });
    document.querySelectorAll('.nav__item').forEach((node) => {
        node.classList.toggle('is-active', node.dataset.pane === name);
    });
}

function wireNav() {
    document.querySelectorAll('.nav__item').forEach((node) => {
        node.addEventListener('click', () => showPane(node.dataset.pane));
    });
}

/**
 * The update card's one line of text, plus whether a Restart button exists.
 *
 * <p>Every state says what it means for the user rather than naming the machinery. "unsupported" in particular
 * has to explain itself: on a mac it is a real limitation (updates need a signed build) and silently showing
 * nothing would read as a check that never finished.
 */
function applyUpdateStatus(status) {
    if (!status) return;
    const line = el('update-status');
    const restart = el('restart-update');
    const check = el('check-updates');

    if (status.currentVersion) {
        el('app-version').textContent = `v${status.currentVersion}`;
    }

    const ready = status.state === 'ready';
    restart.hidden = !ready;
    restart.disabled = false;
    // Nothing left to check for once an update is downloaded — the next step is the restart.
    check.disabled = ready || status.state === 'checking' || status.state === 'downloading'
        || status.state === 'unsupported';

    switch (status.state) {
        case 'checking':
            line.textContent = 'Checking for updates…';
            break;
        case 'current':
            line.textContent = 'You are on the latest version.';
            break;
        case 'downloading':
            line.textContent = `Downloading ${status.version || 'the update'}… ${status.percent || 0}%`;
            break;
        case 'ready':
            line.textContent = `Version ${status.version} is ready. It installs when you restart — `
                + 'or automatically the next time you close the app.';
            break;
        case 'unsupported':
            line.textContent = status.reason || 'Automatic updates are not available here.';
            break;
        case 'error':
            line.textContent = `Could not check for updates: ${status.error}`;
            break;
        default:
            line.textContent = '';
    }
}

/* ------------------------------------------------------------------ GreenSplit */

const OBS_HINT = 'In OBS, open Tools → WebSocket Server Settings, turn it on, and copy the password here.';
const OBS_STATE_TEXT = {
    connecting: 'Connecting…',
    retrying: 'Waiting for OBS…',
    'bad-password': 'Wrong password',
    'needs-password': 'Needs password',
    off: 'Not connected',
};
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
/** Seconds of Undo before a Stop is sent: ending a stream by a stray click is the one mistake that can't be taken back. */
const STOP_UNDO_SECONDS = 5;

let obsStatus = null;
let obsSettings = {};
let obsFound = null; // the last scan's rows, or null while none has run
let obsSearching = false;
let obsStop = null; // { left, timer } while a Stop waits out its Undo
let obsBusy = false; // a Start or Stop is on its way to OBS
let obsTicker = null;

/** The card's hint line doubles as its error line, so an error shows where you're looking and nothing shifts. */
function setObsHint(error) {
    const hint = el('obs-hint');
    hint.textContent = error || OBS_HINT;
    hint.className = `hint${error ? ' hint--bad' : ''}`;
}

function obsPlace() {
    if (obsSettings.obsLocal !== false) return { name: 'This PC', host: '' };
    let host = '';
    try { host = new URL(obsSettings.obsUrl).hostname; } catch (error) { host = obsSettings.obsUrl || ''; }
    return { name: obsSettings.obsName || host, host: obsSettings.obsName ? host : '' };
}

function renderObsWhere() {
    const { name, host } = obsPlace();
    const node = el('obs-where');
    node.textContent = name;
    if (host) {
        const small = document.createElement('small');
        small.textContent = host;
        node.appendChild(small);
    }
}

function formatUptime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const STREAM_PILL = {
    reconnecting: ['Reconnecting', 'pill--warn', 'OBS lost the stream server and is trying again.'],
    starting: ['Starting…', 'pill--warn', ''],
    stopping: ['Ending…', 'pill--warn', ''],
    off: ['Not live', 'pill--off', ''],
};

/** The stream row: what the stream is doing, and the one action that fits it. */
function renderObsStream() {
    const connected = !!(obsStatus && obsStatus.connected);
    el('obs-stream').hidden = !connected;
    if (!connected) {
        cancelObsStop();
        clearInterval(obsTicker);
        obsTicker = null;
        return;
    }
    const stream = obsStatus.stream || { state: 'off' };
    const live = el('obs-live');
    const note = el('obs-stream-note');
    let [text, tone, hint] = STREAM_PILL[stream.state] || STREAM_PILL.off;
    if (stream.state === 'live') {
        text = stream.startedAt != null ? `Live ${formatUptime(Date.now() - stream.startedAt)}` : 'Live';
        tone = 'pill--live';
    }
    if (obsStop) hint = `Ending in ${obsStop.left} s`;
    live.textContent = text;
    live.className = `pill ${tone}`;
    note.textContent = hint;

    const streaming = ['live', 'reconnecting', 'starting'].includes(stream.state);
    el('obs-start').hidden = streaming || stream.state === 'stopping' || !!obsStop;
    el('obs-stop').hidden = !streaming || !!obsStop;
    el('obs-undo').hidden = !obsStop;
    el('obs-start').disabled = obsBusy;
    el('obs-stop').disabled = obsBusy;

    // A 1 s tick only while the uptime is on screen and counting.
    const ticking = stream.startedAt != null && streaming;
    if (ticking && !obsTicker) {
        obsTicker = setInterval(renderObsStream, 1000);
    } else if (!ticking && obsTicker) {
        clearInterval(obsTicker);
        obsTicker = null;
    }
}

function applyObsStatus(status) {
    if (!status) return;
    obsStatus = status;
    const on = status.state === 'connected';
    const bad = status.state === 'bad-password' || status.state === 'needs-password';
    el('obs-conn-dot').className = `dot ${on ? 'dot--on' : bad ? 'dot--bad' : 'dot--off'}`;
    el('obs-conn-text').textContent = on ? 'Connected' : (OBS_STATE_TEXT[status.state] || 'Not connected');
    setPill(el('obs-status'), on, 'Online', 'Offline');
    el('obs-dot').className = `dot ${on ? 'dot--on' : 'dot--off'}`;
    // Connect only when nothing is trying; Disconnect also stops a reconnect loop that's waiting for the other PC.
    const idle = ['off', 'bad-password', 'needs-password'].includes(status.state);
    el('obs-connect').hidden = !idle;
    el('obs-disconnect').hidden = idle;
    setObsHint(on ? null : status.error);
    // Setup words are for setting up: once connected the line goes (an error still shows, in the same place).
    el('obs-hint').hidden = on;
    // Connected to the PC that was picked: the search is done, so fold the list away.
    if (on && obsFound && obsFound.some((row) => row.url === status.url)) obsFound = null;
    renderObsFound();
    renderObsStream();
}

function emptyRow(text) {
    const li = document.createElement('li');
    li.className = 'is-empty';
    li.textContent = text;
    return li;
}

function renderObsFound() {
    const list = el('obs-found');
    list.hidden = !obsSearching && obsFound === null;
    list.replaceChildren();
    if (obsSearching) {
        list.appendChild(emptyRow('Searching this network…'));
        return;
    }
    if (!obsFound) return;
    if (!obsFound.length) {
        list.appendChild(emptyRow('No OBS found. On that PC, turn on Tools → WebSocket Server Settings and allow OBS through its firewall on private networks.'));
        return;
    }
    obsFound.forEach((row) => {
        const li = document.createElement('li');
        const current = row.url === obsSettings.obsUrl && obsStatus && obsStatus.connected;
        if (current) li.className = 'is-current';
        const name = document.createElement('span');
        name.className = 'list__name';
        name.textContent = row.local ? 'This PC' : (row.name || row.host);
        const meta = document.createElement('span');
        meta.className = 'list__meta';
        // The address only when there's a name above it: a PC that told us no name is already listed by address.
        meta.textContent = current ? 'Connected' : (row.local || row.name ? row.host : '');
        li.append(name, meta);
        if (row.authRequired) {
            const lock = document.createElement('span');
            lock.title = 'Needs its WebSocket password';
            lock.innerHTML = LOCK_ICON;
            li.appendChild(lock);
        }
        if (!current) li.addEventListener('click', () => useObs(row));
        list.appendChild(li);
    });
}

async function findObs() {
    obsSearching = true;
    el('obs-find').disabled = true;
    renderObsFound();
    try {
        obsFound = await window.lbcbot.findObs();
    } finally {
        obsSearching = false;
        el('obs-find').disabled = false;
        renderObsFound();
    }
}

async function useObs(row) {
    // A typed password goes with the pick, so choosing a PC that needs one is one click once it's in the field.
    if (el('obs-password').value) await window.lbcbot.setObsPassword(el('obs-password').value);
    const result = await window.lbcbot.useObs(row.host);
    if (result && result.ok) {
        obsFound = null; // done: fold the list away
        renderObsFound();
    } else if (result && result.needsPassword) {
        el('obs-password').focus();
    } else if (result && result.error) {
        setObsHint(result.error);
    }
}

async function setStreaming(on) {
    obsBusy = true;
    renderObsStream();
    try {
        const result = await window.lbcbot.setStreaming(on);
        setObsHint(result && !result.ok ? result.error : null);
    } finally {
        obsBusy = false;
        renderObsStream();
    }
}

/** Stop waits STOP_UNDO_SECONDS with Undo in place of the Stop button, then sends. */
function startObsStop() {
    cancelObsStop();
    obsStop = { left: STOP_UNDO_SECONDS, timer: null };
    obsStop.timer = setInterval(() => {
        obsStop.left -= 1;
        if (obsStop.left <= 0) {
            cancelObsStop();
            setStreaming(false);
        } else {
            renderObsStream();
        }
    }, 1000);
    renderObsStream();
    el('obs-undo').focus();
}

function cancelObsStop() {
    if (obsStop) clearInterval(obsStop.timer);
    obsStop = null;
}

const GS_HINT = 'In GreenSplit: WebSocket Server → Enable, then Copy Connection URL.';
const GS_STATE_TEXT = {
    connecting: 'Connecting…',
    'bad-token': 'Wrong access token',
    unreachable: 'GreenSplit isn\'t running',
    'bad-address': 'Can\'t use that address',
    off: 'Not connected',
};

/** The card's hint line doubles as its error line, so an error appears where the URL went in and nothing shifts. */
function setGreenSplitHint(error) {
    const hint = el('gs-hint');
    hint.textContent = error || GS_HINT;
    hint.className = `hint${error ? ' hint--bad' : ''}`;
}

/**
 * GreenSplit's state on its card, in the sidebar and in Settings.
 *
 * Nothing about GreenSplit shows outside its own card until it is set up — most streamers never run a speedrun timer,
 * and an "Offline" pill for something you never asked for reads as something broken.
 */
function applyGreenSplitStatus(status) {
    if (!status) return;
    const on = status.state === 'connected';
    let text = GS_STATE_TEXT[status.state] || 'Not connected';
    if (!status.configured) text = 'Not set up';
    else if (on) text = status.appVersion ? `Connected · GreenSplit ${status.appVersion}` : 'Connected';

    const bad = status.state === 'bad-token' || status.state === 'bad-address';
    el('gs-conn-dot').className = `dot ${on ? 'dot--on' : bad ? 'dot--bad' : 'dot--off'}`;
    el('gs-conn-text').textContent = text;

    el('gs-statusline').hidden = !status.configured;
    setPill(el('gs-status'), on, 'Online', 'Offline');
    el('gs-dot').className = `dot ${on ? 'dot--on' : 'dot--off'}`;

    // Connect only when nothing is trying: while it waits for GreenSplit to open it is already retrying on its own
    // (and a pasted URL applies itself). Disconnect whenever it is on, including while it waits.
    el('gs-connect').hidden = !['off', 'bad-token', 'bad-address'].includes(status.state);
    el('gs-disconnect').hidden = status.state === 'off' || status.state === 'bad-address';
    el('gs-forget').hidden = !status.configured;
    el('gs-control').hidden = !(on && status.controlAvailable === false);
    // What is saved, token masked, so an empty field still says it is set up — like the OBS password.
    el('gs-url').placeholder = status.configured && status.url
        ? `${status.url}?token=••••••••`
        : 'paste from GreenSplit';

    el('gs-forward-row').hidden = !status.configured;
    el('gs-auto-row').hidden = !status.configured;
}

async function connectGreenSplit() {
    const pasted = el('gs-url').value.trim();
    const result = await window.lbcbot.connectGreenSplit(pasted || null);
    if (result && result.ok === false) {
        setGreenSplitHint(result.error);
        return;
    }
    el('gs-url').value = '';
    setGreenSplitHint(null);
}

let wasConnected = false;

/* ------------------------------------------------------------------ LBCBot accounts */

// Static markup of our own (never user data), so innerHTML is safe for these.
const PLATFORM_LABELS = { TWITCH: 'Twitch', YOUTUBE: 'YouTube' };

const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
    // The platform marks the website's account menu uses (PrimeIcons 7 pi-twitch / pi-youtube), drawn inline: the
    // pane's CSP allows no icon font.
    twitch: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.706 7.144H12.874V10.568H11.706M14.916 7.144H16.084V10.568H14.916M7.91599 4L5 6.856V17.144H8.49592V20L11.4201 17.144H13.748L19 12V4M17.832 11.432L15.5041 13.712H13.168L11.126 15.712V13.712H8.49592V5.144H17.832V11.432Z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.67,8.14a2,2,0,0,0-1.42-1.43A48.44,48.44,0,0,0,12,6.38a48.44,48.44,0,0,0-6.25.33A2,2,0,0,0,4.33,8.14,21.27,21.27,0,0,0,4,12a21.42,21.42,0,0,0,.33,3.88,2,2,0,0,0,1.42,1.4,48.44,48.44,0,0,0,6.25.33,48.44,48.44,0,0,0,6.25-.33,2,2,0,0,0,1.42-1.4A21.42,21.42,0,0,0,20,12,21.27,21.27,0,0,0,19.67,8.14Zm-9.31,6.25V9.63L14.55,12l-4.19,2.38Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
};
// One account's name before LBCBot has told us (an account carried over from before the list, until its first read).
const accountName = (row) => row.username || 'Your account';

let accountState = { accounts: [], full: false, adding: null };
let switchingTo = null;
let removing = null;
// The line under the card while no code is out: "Opening your browser…", or why an add failed (in red).
let addNote = null;

/**
 * The LBCBot card: each account on this computer (the one in use ticked; a click on another switches to it, on a
 * signed-out one signs in to it again), a remove per row, and Connect / Add account below. Drawn whole from the pushed
 * state, which never carries a credential.
 */
function renderAccounts() {
    const { accounts, full, adding } = accountState;
    const list = el('lbc-accounts');
    list.replaceChildren();
    // A platform mark only says something when the accounts are on more than one platform (as on the website).
    const platforms = new Set(accounts.map((r) => r.platform).filter(Boolean));
    accounts.forEach((row) => {
        const li = document.createElement('li');
        li.className = `account${row.active ? ' account--active' : ''}${row.signedOut ? ' account--out' : ''}`;
        const name = accountName(row);

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'account__main';
        main.title = row.active ? `Using ${name}` : row.signedOut ? `Sign in to ${name} again` : `Switch to ${name}`;
        if (row.active) main.setAttribute('aria-current', 'true');
        main.disabled = !!switchingTo || removing === row.id || (row.signedOut && !!adding);

        const avatar = document.createElement('span');
        avatar.className = 'account__avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = name.charAt(0).toUpperCase();

        const text = document.createElement('span');
        text.className = 'account__text';
        const label = document.createElement('span');
        label.className = 'account__name';
        label.textContent = name; // textContent: a username is user data
        text.append(label);
        const sub = row.signedOut ? 'Signed out. Click to sign in again.' : switchingTo === row.id ? 'Switching…' : null;
        if (sub) {
            const subEl = document.createElement('span');
            subEl.className = 'account__sub';
            subEl.textContent = sub;
            text.append(subEl);
        }
        main.append(avatar, text);

        if (platforms.size > 1 && PLATFORM_LABELS[row.platform] && ICON[row.platform.toLowerCase()]) {
            const mark = document.createElement('span');
            const key = row.platform.toLowerCase();
            mark.className = `account__platform account__platform--${key}`;
            mark.title = PLATFORM_LABELS[row.platform];
            mark.setAttribute('role', 'img');
            mark.setAttribute('aria-label', PLATFORM_LABELS[row.platform]);
            mark.innerHTML = ICON[key];
            main.append(mark);
        }
        const state = document.createElement('span');
        state.className = 'account__state';
        if (row.active && !row.signedOut) state.innerHTML = ICON.check;
        main.append(state);

        main.addEventListener('click', async () => {
            if (row.active && !row.signedOut) return;
            if (row.signedOut) {
                startAdd();
                return;
            }
            switchingTo = row.id;
            renderAccounts();
            try {
                const result = await window.lbcbot.switchAccount(row.id);
                if (!result.ok && result.error) appendLog(result.error);
            } catch (error) {
                appendLog(`Switching failed: ${error.message}`);
            } finally {
                switchingTo = null;
                renderAccounts();
            }
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'icon-btn icon-btn--danger account__remove';
        remove.title = `Remove ${name} from this computer`;
        remove.setAttribute('aria-label', `Remove ${name} from this computer`);
        remove.innerHTML = ICON.trash;
        remove.disabled = removing === row.id;
        remove.addEventListener('click', async () => {
            removing = row.id;
            renderAccounts();
            try {
                await window.lbcbot.removeAccount(row.id);
            } catch (error) {
                appendLog(`Removing failed: ${error.message}`);
            } finally {
                removing = null;
                renderAccounts();
            }
        });

        li.append(main, remove);
        list.append(li);
    });
    list.hidden = !accounts.length;

    const none = !accounts.length;
    el('lbc-intro').hidden = !none;
    const add = el('lbc-add');
    // None yet: the card's one filled button. After that, adding is the quieter outline next to the list.
    add.className = none ? 'primary' : 'account-add';
    add.innerHTML = none ? 'Connect' : `${ICON.plus}<span>Add account</span>`;
    add.title = none ? '' : 'Sign in to another LBCBot account on this computer';
    add.disabled = !!adding;
    add.hidden = full && !adding;
    el('lbc-full').hidden = !(full && !adding);

    const code = el('device-code');
    if (adding) {
        // The code in bold: it is what you compare with the browser's page.
        const strong = document.createElement('strong');
        strong.className = 'device-code__code';
        strong.textContent = adding.userCode;
        code.replaceChildren('Approve code ', strong, ` in your browser (it should have opened at ${adding.verificationUri}).`);
    } else {
        code.textContent = (addNote && addNote.text) || '';
    }
    code.className = `hint${!adding && addNote && addNote.bad ? ' hint--bad' : ''}`;
    code.hidden = !code.textContent;
}

async function startAdd() {
    addNote = { text: 'Opening your browser…' };
    renderAccounts();
    const result = await window.lbcbot.addAccount();
    addNote = result && result.ok ? null : { text: (result && result.error) || "Couldn't reach LBCBot. Try again.", bad: true };
    renderAccounts();
}

function applyState(state) {
    if (!state) return;
    if (state.settings) {
        // Only write inputs the user is not currently editing, or typing gets clobbered by a push update.
        const assign = (node, value) => {
            if (document.activeElement !== node) node.value = value ?? '';
        };
        assign(el('obs-url'), state.settings.obsUrl);
        obsSettings = state.settings;
        renderObsWhere();
        // What is saved, masked, so an empty field still says a password is set (like GreenSplit's token).
        el('obs-password').placeholder = state.hasObsPassword ? '••••••••  (saved)' : 'from OBS → Tools → WebSocket Server Settings';
        el('forward-events').checked = state.settings.forwardObsEvents !== false;
        el('auto-connect').checked = state.settings.autoConnectObs !== false;
        assign(el('gs-port'), state.settings.greensplitLivesplitPort);
        el('gs-port').dataset.saved = state.settings.greensplitLivesplitPort ?? '';
        el('gs-forward').checked = state.settings.forwardGreensplitEvents !== false;
        el('gs-auto-connect').checked = state.settings.autoConnectGreensplit !== false;
    }
    applyGreenSplitStatus(state.greensplit);
    // Coming online is when the account's lists first become readable, so read them then too.
    const wasConnectedBefore = wasConnected;
    if (state.lbcbotConnected && !wasConnected) refreshAccountLists();
    wasConnected = !!state.lbcbotConnected;
    setStatus('lbc', state.lbcbotConnected);
    setStatus('obs', state.obsConnected);
    applyObsStatus(state.obs);
    const switched = accountState.accounts.find((r) => r.active)?.id !== (state.accounts || []).find((r) => r.active)?.id;
    accountState = { accounts: state.accounts || [], full: !!state.accountsFull, adding: state.adding || null };
    if (state.maxAccounts) el('lbc-full').textContent = `Up to ${state.maxAccounts} accounts. Remove one to add another.`;
    renderAccounts();
    // Another account's overlays, dashboards, platforms and templates.
    if (switched && state.lbcbotConnected && wasConnectedBefore) refreshAccountLists();
}

function refreshAccountLists() {
    refreshOverlays();
    refreshDashboards();
    refreshPlatforms();
    refreshTemplates();
}

async function refreshOverlays() {
    const list = el('overlay-list');
    list.textContent = '';

    const [overlays, scenes] = await Promise.all([window.lbcbot.getOverlays(), window.lbcbot.getScenes()]);

    const sceneSelect = el('scene-select');
    const previous = sceneSelect.value;
    sceneSelect.textContent = '';
    (scenes || []).forEach((scene) => {
        const option = document.createElement('option');
        option.value = scene;
        option.textContent = scene;
        sceneSelect.appendChild(option);
    });
    if (previous && (scenes || []).includes(previous)) sceneSelect.value = previous;
    if (!scenes || scenes.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Connect to OBS to list scenes';
        sceneSelect.appendChild(option);
    }

    if (!overlays || overlays.length === 0) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'No overlays found. Connect to LBCBot, or create one on the website.';
        list.appendChild(li);
        return;
    }

    overlays.forEach((overlay) => {
        const li = document.createElement('li');

        const name = document.createElement('span');
        name.className = 'list__name';
        // textContent, never innerHTML — an overlay name is user data.
        name.textContent = overlay.name || `Overlay ${overlay.overlayId}`;

        const size = document.createElement('span');
        size.className = 'list__meta';
        size.textContent = `${overlay.canvasWidth || 1920}×${overlay.canvasHeight || 1080}`;

        const button = document.createElement('button');
        // A row action, so the quiet outline — the one filled button per surface is reserved for the main action.
        button.textContent = 'Add to OBS';
        button.addEventListener('click', async () => {
            button.disabled = true;
            button.textContent = 'Adding…';
            const result = await window.lbcbot.addOverlayToObs({
                overlayId: overlay.overlayId,
                overlayName: overlay.name,
                sceneName: sceneSelect.value,
                width: overlay.canvasWidth,
                height: overlay.canvasHeight,
            });
            button.textContent = result.ok ? 'Added' : 'Failed';
            if (!result.ok) appendLog(`Could not add overlay: ${result.error}`);
            setTimeout(() => {
                button.disabled = false;
                button.textContent = 'Add to OBS';
            }, 2000);
        });

        li.append(name, size, button);
        list.appendChild(li);
    });
}

/**
 * Populate the dashboard picker.
 *
 * Built with `textContent` rather than innerHTML, like the rest of this renderer: a dashboard's name is user
 * data, and this page runs under a strict CSP precisely so that it can never become markup.
 */
async function refreshDashboards() {
    const select = el('dashboard-select');
    const previous = select.value;
    select.textContent = '';

    const dashboards = await window.lbcbot.getDashboards();

    if (!dashboards || dashboards.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Connect to list your dashboards';
        select.appendChild(option);
        return;
    }

    dashboards.forEach((d) => {
        const option = document.createElement('option');
        option.value = d.dashboardId;
        option.textContent = d.name || `Dashboard ${d.dashboardId}`;
        select.appendChild(option);
    });
    if (previous && dashboards.some((d) => String(d.dashboardId) === previous)) {
        select.value = previous;
    }
}

/* ------------------------------------------------------------------ linked platforms */

/**
 * Which platforms the ACCOUNT has linked, as opposed to whether this machine is connected to LBCBot.
 *
 * Read-only here. Linking is an OAuth consent that has to complete against the website's registered redirect
 * URI, so the app reports the state and hands off; see the open-integrations handler for why the URL is not
 * built here.
 */
async function refreshPlatforms() {
    const show = (name, connected, note) => {
        el(`${name}-dot`).className = `dot ${connected ? 'dot--on' : 'dot--off'}`;
        const state = el(`${name}-state`);
        state.textContent = note;
        state.className = `platform__state${connected ? ' platform__state--on' : ''}`;
    };

    const data = await window.lbcbot.getPlatforms();
    if (!data) {
        // Distinguish "not linked" from "we could not ask" — they look identical otherwise and lead somewhere
        // completely different.
        show('twitch', false, 'Connect LBCBot first');
        show('youtube', false, 'Connect LBCBot first');
        return;
    }
    const linked = data.connectedPlatforms || [];
    const login = (data.loginPlatform || '').toUpperCase();
    linkedPlatforms = ['TWITCH', 'YOUTUBE'].filter((key) => linked.includes(key));
    [['twitch', 'TWITCH'], ['youtube', 'YOUTUBE']].forEach(([id, key]) => {
        const connected = linked.includes(key);
        // The login platform cannot be unlinked without losing the way you sign in, so say so rather than
        // implying it is optional.
        const note = connected ? (key === login ? 'Connected — sign-in account' : 'Connected') : 'Not connected';
        show(id, connected, note);
    });
    // The template editor's platform choice and the list's platform tags depend on what is linked.
    renderTemplateList();
    if (!selectedTemplateId) showPlatformFields(editorPlatform(null), true);
}

/* ------------------------------------------------------------------ stream templates */

/**
 * YouTube's video categories.
 *
 * Hard-coded rather than fetched from videoCategories.list: the list is tiny, effectively frozen, and region
 * dependent in ways that only add failure modes here. These are the ones a live stream plausibly uses; the
 * blank entry means "leave whatever the broadcast already has".
 */
const YT_CATEGORIES = [
    ['', 'Leave unchanged'],
    ['20', 'Gaming'],
    ['24', 'Entertainment'],
    ['22', 'People & Blogs'],
    ['10', 'Music'],
    ['23', 'Comedy'],
    ['27', 'Education'],
    ['28', 'Science & Technology'],
    ['26', 'Howto & Style'],
    ['17', 'Sports'],
];

let templates = [];
/** The template being edited; null means the editor holds an unsaved new one. */
let selectedTemplateId = null;
/**
 * One platform per template, as on the website: the editor shows only that platform's fields. A new template's
 * platform is picked in the editor (only offered when both are linked); an existing one keeps its own.
 */
let linkedPlatforms = [];
let newTemplatePlatform = null;

function editorPlatform(template) {
    if (template && template.platform) return template.platform;
    if (newTemplatePlatform && linkedPlatforms.includes(newTemplatePlatform)) return newTemplatePlatform;
    return linkedPlatforms[0] || 'TWITCH';
}

function showPlatformFields(platform, isNew) {
    el('tpl-twitch').hidden = platform !== 'TWITCH';
    el('tpl-youtube').hidden = platform !== 'YOUTUBE';
    el('tpl-platform-row').hidden = !(isNew && linkedPlatforms.length > 1);
    document.querySelectorAll('#tpl-platform button').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.platform === platform);
    });
}

function setTemplateStatus(message) {
    el('template-status').textContent = message || '';
}

/** Read the editor into the wire shape. Blank strings become null, which the server reads as "leave alone". */
function readTemplateForm() {
    const value = (id) => {
        const raw = el(id).value.trim();
        return raw === '' ? null : raw;
    };
    const current = templates.find((t) => t.streamTemplateId === selectedTemplateId);
    return {
        name: value('template-name') || 'Untitled',
        platform: editorPlatform(current),
        twitchTitle: value('tw-title'),
        twitchCategory: value('tw-category'),
        // Only meaningful while it matches the typed name — see onCategoryInput.
        twitchCategoryId: el('tw-category').dataset.gameId || null,
        twitchTags: value('tw-tags'),
        youtubeTitle: value('yt-title'),
        youtubeDescription: value('yt-description'),
        youtubeCategoryId: value('yt-category'),
        youtubeTags: value('yt-tags'),
        youtubeLanguage: value('yt-language'),
        // Never offered in the UI — see the hint in the pane.
        youtubeMadeForKids: false,
        youtubeSyntheticMedia: el('yt-synthetic').checked,
    };
}

function fillTemplateForm(template) {
    const t = template || {};
    el('template-name').value = t.name || '';
    el('tw-title').value = t.twitchTitle || '';
    el('tw-category').value = t.twitchCategory || '';
    el('tw-category').dataset.gameId = t.twitchCategoryId || '';
    el('tw-tags').value = t.twitchTags || '';
    el('yt-title').value = t.youtubeTitle || '';
    el('yt-description').value = t.youtubeDescription || '';
    el('yt-category').value = t.youtubeCategoryId || '';
    el('yt-tags').value = t.youtubeTags || '';
    el('yt-language').value = t.youtubeLanguage || '';
    el('yt-synthetic').checked = Boolean(t.youtubeSyntheticMedia);
    el('template-editor-title').textContent = t.streamTemplateId ? (t.name || 'Template') : 'New template';
    showPlatformFields(editorPlatform(template), !t.streamTemplateId);
    // Apply and Delete are meaningless until the thing exists server-side.
    el('template-apply').disabled = !t.streamTemplateId;
    el('template-delete').disabled = !t.streamTemplateId;
    setTemplateStatus('');
}

function selectTemplate(id) {
    selectedTemplateId = id;
    fillTemplateForm(templates.find((t) => t.streamTemplateId === id));
    renderTemplateList();
}

/** Built with textContent and real buttons — template names are user data and this page has a strict CSP. */
function renderTemplateList() {
    const list = el('template-list');
    list.textContent = '';
    if (!templates.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'No templates yet.';
        list.appendChild(li);
        return;
    }
    templates.forEach((t) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `template-row${t.streamTemplateId === selectedTemplateId ? ' is-active' : ''}`;
        button.textContent = t.name || `Template ${t.streamTemplateId}`;
        // With both platforms linked, each row says which one it is for; with one, that would be noise.
        if (linkedPlatforms.length > 1 && t.platform) {
            const tag = document.createElement('span');
            tag.className = `tag tag--${t.platform.toLowerCase()}`;
            tag.textContent = PLATFORM_LABELS[t.platform] || t.platform;
            button.appendChild(tag);
        }
        button.addEventListener('click', () => selectTemplate(t.streamTemplateId));
        li.appendChild(button);
        list.appendChild(li);
    });
}

async function refreshTemplates(selectId) {
    templates = (await window.lbcbot.getStreamTemplates()) || [];
    if (selectId !== undefined) {
        selectedTemplateId = selectId;
    }
    if (selectedTemplateId && !templates.some((t) => t.streamTemplateId === selectedTemplateId)) {
        selectedTemplateId = null;
    }
    renderTemplateList();
    if (selectedTemplateId) {
        fillTemplateForm(templates.find((t) => t.streamTemplateId === selectedTemplateId));
    }
}

/**
 * Twitch category typeahead.
 *
 * The id is what gets saved, so it is cleared on every keystroke and only re-set when the typed text matches a
 * suggestion exactly. Otherwise editing "Doom" into "Doom Eternal" would keep Doom's id and silently apply the
 * wrong game — the server can still resolve a bare name, so losing the id degrades to a lookup rather than an
 * error.
 */
let categoryTimer = null;
function onCategoryInput() {
    const input = el('tw-category');
    const options = el('tw-category-options');
    const typed = input.value.trim();
    const match = Array.from(options.options).find((o) => o.value.toLowerCase() === typed.toLowerCase());
    input.dataset.gameId = match ? match.dataset.gameId : '';

    if (categoryTimer) clearTimeout(categoryTimer);
    if (typed.length < 2) return;
    // Debounced: this is a Twitch API call per keystroke otherwise.
    categoryTimer = setTimeout(async () => {
        const results = await window.lbcbot.searchTwitchCategories(typed);
        options.textContent = '';
        (results || []).forEach((game) => {
            const option = document.createElement('option');
            option.value = game.name;
            option.dataset.gameId = game.id;
            options.appendChild(option);
        });
        // Re-check after results land: the user may have typed the full name before the search returned.
        const now = input.value.trim().toLowerCase();
        const fresh = Array.from(options.options).find((o) => o.value.toLowerCase() === now);
        if (fresh) input.dataset.gameId = fresh.dataset.gameId;
    }, 300);
}

function wireTemplates() {
    const ytCategory = el('yt-category');
    YT_CATEGORIES.forEach(([id, label]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        ytCategory.appendChild(option);
    });

    el('tw-category').addEventListener('input', onCategoryInput);

    document.querySelectorAll('#tpl-platform button').forEach((b) => {
        b.addEventListener('click', () => {
            newTemplatePlatform = b.dataset.platform;
            showPlatformFields(newTemplatePlatform, true);
        });
    });

    el('template-new').addEventListener('click', () => {
        selectedTemplateId = null;
        fillTemplateForm(null);
        renderTemplateList();
        el('template-name').focus();
    });

    el('template-save').addEventListener('click', async () => {
        setTemplateStatus('Saving…');
        const result = await window.lbcbot.saveStreamTemplate(selectedTemplateId, readTemplateForm());
        if (!result || !result.ok) {
            setTemplateStatus('Could not save — see Activity.');
            return;
        }
        await refreshTemplates(result.data.streamTemplateId);
        setTemplateStatus('Saved.');
    });

    el('template-delete').addEventListener('click', async () => {
        if (!selectedTemplateId) return;
        const result = await window.lbcbot.deleteStreamTemplate(selectedTemplateId);
        if (!result || !result.ok) {
            setTemplateStatus('Could not delete — see Activity.');
            return;
        }
        selectedTemplateId = null;
        fillTemplateForm(null);
        await refreshTemplates(null);
    });

    el('template-apply').addEventListener('click', async () => {
        if (!selectedTemplateId) return;
        const button = el('template-apply');
        button.disabled = true;
        setTemplateStatus('Applying…');
        const result = await window.lbcbot.applyStreamTemplate(selectedTemplateId);
        button.disabled = false;
        if (!result || !result.ok) {
            setTemplateStatus('Could not apply — see Activity.');
            return;
        }
        /*
         * Report both halves, not an overall verdict. They succeed and fail independently — "Twitch updated,
         * YouTube skipped because you are not live" is the useful answer, and a single line saying "failed"
         * would be wrong about the half that worked.
         */
        const parts = ['twitch', 'youtube']
            .map((p) => result.data[p])
            .filter((o) => o && o.attempted)
            .map((o) => o.message);
        setTemplateStatus(parts.length ? parts.join(' ') : 'Nothing in this template to apply.');
    });
}

function wire() {
    el('lbc-add').addEventListener('click', startAdd);
    window.lbcbot.onAddAccountDone((outcome) => {
        addNote = outcome.ok ? null : { text: outcome.error, bad: true };
        renderAccounts();
    });

    el('refresh-platforms').addEventListener('click', refreshPlatforms);
    el('open-integrations').addEventListener('click', () => window.lbcbot.openIntegrations());

    el('obs-connect').addEventListener('click', async () => {
        await window.lbcbot.setObsPassword(el('obs-password').value);
        await window.lbcbot.connectObs();
        await refreshOverlays();
    });
    el('obs-disconnect').addEventListener('click', () => window.lbcbot.disconnectObs());
    el('obs-password').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') el('obs-connect').click();
    });
    el('obs-find').addEventListener('click', findObs);
    el('obs-start').addEventListener('click', () => setStreaming(true));
    el('obs-stop').addEventListener('click', startObsStop);
    el('obs-undo').addEventListener('click', () => {
        cancelObsStop();
        renderObsStream();
        el('obs-stop').focus();
    });

    // Pasting the Connection URL is the whole setup — no button press needed. Enter or Connect does the same.
    el('gs-connect').addEventListener('click', connectGreenSplit);
    el('gs-disconnect').addEventListener('click', () => window.lbcbot.disconnectGreenSplit());
    el('gs-forget').addEventListener('click', async () => {
        await window.lbcbot.forgetGreenSplit();
        el('gs-url').value = '';
        setGreenSplitHint(null);
    });
    el('gs-url').addEventListener('paste', () => setTimeout(connectGreenSplit, 0));
    el('gs-url').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') connectGreenSplit();
    });
    el('gs-url').addEventListener('input', () => setGreenSplitHint(null));
    el('gs-port').addEventListener('change', () => {
        const port = Number(el('gs-port').value.trim());
        if (Number.isInteger(port) && port > 0 && port < 65536) {
            window.lbcbot.updateSettings({ greensplitLivesplitPort: port });
        } else {
            // Not a port: put the saved one back rather than keep something that can never connect.
            el('gs-port').value = el('gs-port').dataset.saved || '';
        }
    });

    el('refresh-overlays').addEventListener('click', refreshOverlays);

    el('refresh-dashboards').addEventListener('click', refreshDashboards);
    el('open-dashboard').addEventListener('click', async () => {
        // An empty value means "no specific dashboard" — the main process then loads the picker page instead.
        el('dashboard-status').textContent = '';
        const result = await window.lbcbot.openDashboard(el('dashboard-select').value || null);
        /*
         * The result used to be discarded, so a refusal looked like a dead button. The main process declines
         * to open a dashboard it cannot sign in — otherwise the window lands on the public landing page and
         * the app looks broken — so this is where that reason has to appear.
         */
        if (result && result.ok === false) {
            el('dashboard-status').textContent = result.error || 'Could not open that dashboard.';
        }
    });

    const persist = () => window.lbcbot.updateSettings({
        obsUrl: el('obs-url').value.trim(),
        forwardObsEvents: el('forward-events').checked,
        autoConnectObs: el('auto-connect').checked,
        forwardGreensplitEvents: el('gs-forward').checked,
        autoConnectGreensplit: el('gs-auto-connect').checked,
    });
    el('obs-url').addEventListener('change', persist);
    ['forward-events', 'auto-connect', 'gs-forward', 'gs-auto-connect']
        .forEach((id) => el(id).addEventListener('change', persist));

    el('check-updates').addEventListener('click', async () => {
        el('update-status').textContent = 'Checking…';
        applyUpdateStatus(await window.lbcbot.checkForUpdates());
    });
    el('restart-update').addEventListener('click', async () => {
        el('restart-update').disabled = true;
        const result = await window.lbcbot.restartForUpdate();
        if (!result || !result.ok) {
            el('restart-update').disabled = false;
            el('update-status').textContent = (result && result.error) || 'Could not start the update.';
        }
    });

    window.lbcbot.onState(applyState);
    window.lbcbot.onUpdateStatus(applyUpdateStatus);
    window.lbcbot.onLog(appendLog);
    window.lbcbot.onObsStatus((status) => {
        setStatus('obs', status.connected);
        applyObsStatus(status);
    });
    window.lbcbot.onGreenSplitStatus(applyGreenSplitStatus);
}

(async function init() {
    wireNav();
    wire();
    wireTemplates();
    const { logLines, update } = await window.lbcbot.getState();
    (logLines || []).forEach(appendLog);
    // Pulled rather than waited for: the first check can finish before this window mounts, and an update sitting
    // ready to install must not be invisible until the next six-hour tick.
    applyUpdateStatus(update);
    fillTemplateForm(null);
    await refreshOverlays();
    await refreshDashboards();
    await refreshPlatforms();
    await refreshTemplates();
})();
