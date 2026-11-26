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
 * The pills live in the rail rather than in a pane so that connection state is readable from every
 * pane — the one piece of state that matters no matter what you are doing.
 */
function setStatus(name, on) {
    // LBCBot's line is the account chip (renderAccounts draws its dot and words).
    if (name === 'lbc') {
        lbcOnline = !!on;
        renderAccountChip();
        return;
    }
    // "Online / Offline" rather than "Connected / Not connected": the rail is 200px, and the longer words wrapped
    // the pill onto two lines, then (with "GreenSplit" as a label) pushed it past the rail's edge. The dot carries
    // the same meaning anyway, so the word only has to confirm it. The cards say "Connected" in full.
    setPill(el(`${name}-status`), on, 'Online', 'Offline');
    el(`${name}-dot`).className = `dot ${on ? 'dot--on' : 'dot--off'}`;

    // Only offer what can happen now: Connect while offline, Disconnect while connected.
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
 * to learn its name. Settings isn't in the nav (2026-11-26): it opens from the account menu, and from the rail's OBS and
 * GreenSplit lines, the place each is fixed. Deliberately not persisted: a launch opens on Dashboards, the pane used
 * every stream, or on Settings while no account is connected yet (applyState).
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
    settings: () => refreshPlatforms(),
};

function showPane(name) {
    const pane = el(`pane-${name}`);
    if (!pane) return;
    if (PANE_REFRESH[name]) PANE_REFRESH[name]();
    document.querySelectorAll('.pane').forEach((node) => {
        node.classList.toggle('is-active', node === pane);
    });
    document.querySelectorAll('.nav__item, #acct-settings').forEach((node) => {
        node.classList.toggle('is-active', node.dataset.pane === name);
    });
}

function wireNav() {
    document.querySelectorAll('.nav [data-pane]').forEach((node) => {
        node.addEventListener('click', () => {
            showPane(node.dataset.pane);
            setMenuOpen(false);
        });
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

function obsHost() {
    try { return new URL(obsSettings.obsUrl).hostname; } catch (error) { return obsSettings.obsUrl || ''; }
}

/** A PC's name: the one given in the app, else what the network reported, else nothing (its address shows). */
function obsNameFor(host, reported, local) {
    const given = (obsSettings.obsNames || {})[host];
    if (given) return given;
    if (local) return 'This PC';
    return reported || '';
}

function obsPlace() {
    const host = obsHost();
    const local = obsSettings.obsLocal !== false;
    const name = obsNameFor(host, obsSettings.obsName, local);
    // The address beside a name, small; never beside "This PC" (127.0.0.1 tells nobody anything).
    return { name: name || host, host: name && !local ? host : '' };
}

function startObsRename() {
    const input = el('obs-rename-input');
    input.value = (obsSettings.obsNames || {})[obsHost()] || obsPlace().name;
    el('obs-where').hidden = true;
    el('obs-rename').hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
}

/** Save (or with `save` false, drop) the rename. An empty name goes back to the reported one. */
async function endObsRename(save) {
    const input = el('obs-rename-input');
    if (input.hidden) return;
    input.hidden = true;
    el('obs-where').hidden = false;
    el('obs-rename').hidden = false;
    if (!save) return;
    const host = obsHost();
    const names = { ...(obsSettings.obsNames || {}) };
    const name = input.value.trim().slice(0, 40);
    if (name) names[host] = name;
    else delete names[host];
    obsSettings = { ...obsSettings, obsNames: names };
    renderObsWhere();
    if (obsFound) renderObsFound();
    await window.lbcbot.updateSettings({ obsNames: names });
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
        const label = obsNameFor(row.host, row.name, row.local);
        name.textContent = label || row.host;
        const meta = document.createElement('span');
        meta.className = 'list__meta';
        // The address only when there's a name above it: a PC that told us no name is already listed by address.
        meta.textContent = current ? 'Connected' : (label ? row.host : '');
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
let statedOnce = false;

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
let lbcOnline = false;
// The line under Add account while no code is out: "Opening your browser…", or why an add failed (in red).
let addNote = null;

const menuOpen = () => !el('acct-menu').hidden;

function setMenuOpen(open) {
    el('acct-menu').hidden = !open;
    el('acct-chip').setAttribute('aria-expanded', open ? 'true' : 'false');
    el('acct').classList.toggle('is-open', open);
}

/**
 * The sidebar's account chip: the account in use (its initial, name, and LBCBot's connection under it, the dot on the
 * avatar). With none yet it reads "Not connected" and a click starts the sign-in straight away.
 */
function renderAccountChip() {
    const { accounts, adding } = accountState;
    const active = accounts.find((r) => r.active) || null;
    const none = !accounts.length;
    const name = active ? accountName(active) : 'LBCBot';

    el('acct-name').textContent = name; // textContent: a username is user data
    const initial = el('acct-initial');
    if (none) initial.innerHTML = ICON.plus;
    else initial.textContent = name.charAt(0).toUpperCase();
    el('acct-avatar').className = `acct__avatar${none ? ' acct__avatar--none' : ''}${active && active.signedOut ? ' acct__avatar--out' : ''}`;

    const sub = el('lbc-status');
    let text;
    let tone;
    if (switchingTo) [text, tone] = ['Switching…', 'muted'];
    else if (adding) [text, tone] = ['Approve the code', 'warn'];
    else if (none) [text, tone] = ['Not connected', 'muted'];
    else if (active && active.signedOut) [text, tone] = ['Signed out', 'muted'];
    else [text, tone] = lbcOnline ? ['Online', 'on'] : ['Offline', 'muted'];
    sub.textContent = text;
    sub.className = `acct__sub acct__sub--${tone}`;
    el('lbc-dot').className = `dot ${lbcOnline && !none ? 'dot--on' : 'dot--off'} acct__presence`;

    const chip = el('acct-chip');
    chip.title = none ? 'Connect this computer to your LBCBot account' : 'Switch or add accounts';
}

/**
 * The account menu: each account on this computer (the one in use ticked; a click on another switches to it, on a
 * signed-out one signs in to it again), a remove per row, then Add account and the code to approve. Drawn whole from
 * the pushed state, which never carries a credential.
 */
function renderAccounts() {
    const { accounts, full, adding } = accountState;
    renderAccountChip();

    const list = el('lbc-accounts');
    list.replaceChildren();
    // A platform mark only says something when the accounts are on more than one platform (as on the website).
    const platforms = new Set(accounts.map((r) => r.platform).filter(Boolean));
    // The one in use first, so the menu opens with "who am I" on top and the others to switch to under it.
    const ordered = [...accounts].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    ordered.forEach((row) => {
        const li = document.createElement('li');
        li.className = `account${row.active ? ' account--active' : ''}${row.signedOut ? ' account--out' : ''}`;
        const name = accountName(row);

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'account__main';
        main.title = row.active && !row.signedOut ? `Using ${name}` : row.signedOut ? `Sign in to ${name} again` : `Switch to ${name}`;
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
        const sub = row.signedOut ? 'Signed out' : switchingTo === row.id ? 'Switching…' : null;
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
            let ok = false;
            try {
                const result = await window.lbcbot.switchAccount(row.id);
                ok = !!(result && result.ok);
                if (!ok && result && result.error) addNote = { text: result.error, bad: true };
            } catch (error) {
                addNote = { text: `Switching failed: ${error.message}`, bad: true };
            } finally {
                switchingTo = null;
                // Switched: the chip now shows who you are, so the menu has done its job.
                if (ok) setMenuOpen(false);
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
    const add = el('lbc-add');
    add.innerHTML = `${ICON.plus}<span>${none ? 'Connect an account' : 'Add account'}</span>`;
    add.title = 'Sign in to another LBCBot account on this computer';
    add.disabled = !!adding;
    add.hidden = full && !adding;
    el('lbc-full').hidden = !(full && !adding);

    // First run: the Settings pane's Connect card, until there is an account.
    el('lbc-card').hidden = !none;
    el('lbc-connect').disabled = !!adding;
    renderCode(el('device-code'));
    renderCode(el('lbc-card-code'));
}

// The code to approve (or the add's note), wherever the add was started from: the menu and the first-run card.
function renderCode(node) {
    const { adding } = accountState;
    if (adding) {
        // The code in bold: it is what you compare with the browser's page.
        const strong = document.createElement('strong');
        strong.className = 'device-code__code';
        strong.textContent = adding.userCode;
        node.replaceChildren('Approve code ', strong, ` in your browser (it should have opened at ${adding.verificationUri}).`);
    } else {
        node.textContent = (addNote && addNote.text) || '';
    }
    node.classList.toggle('hint--bad', !adding && !!(addNote && addNote.bad));
    node.hidden = !node.textContent;
}

async function startAdd() {
    addNote = { text: 'Opening your browser…' };
    renderAccounts();
    const result = await window.lbcbot.addAccount();
    addNote = result && result.ok ? null : { text: (result && result.error) || "Couldn't reach LBCBot. Try again.", bad: true };
    renderAccounts();
}

function wireAccountMenu() {
    el('acct-chip').addEventListener('click', () => {
        // No account yet: one click starts the sign-in, and the menu opens to show the code.
        if (!accountState.accounts.length && !accountState.adding) {
            setMenuOpen(true);
            startAdd();
            return;
        }
        if (!menuOpen()) addNote = null; // a stale note from last time doesn't greet you
        setMenuOpen(!menuOpen());
        renderAccounts();
    });
    el('lbc-add').addEventListener('click', startAdd);
    el('lbc-connect').addEventListener('click', startAdd);
    // Closes on a click outside it and on Esc, like every popover in the app.
    document.addEventListener('mousedown', (event) => {
        if (menuOpen() && !el('acct').contains(event.target)) setMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && menuOpen()) {
            setMenuOpen(false);
            el('acct-chip').focus();
        }
    });
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
    // The first state: with no account yet, open on Settings, where Connect is.
    if (!statedOnce && Array.isArray(state.accounts)) {
        statedOnce = true;
        if (!state.accounts.length) showPane('settings');
    }
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
}

/* ------------------------------------------------------------------ stream templates */

/*
 * Stream setup: the website's Stream Planner (templates half), in plain DOM. Every row has its own Apply; edits save
 * themselves a moment after you stop typing; Delete is immediate and offers Undo. Everything is built with
 * textContent and real elements — template names and categories are user data and this page has a strict CSP.
 */

/**
 * YouTube's video categories.
 *
 * Hard-coded rather than fetched from videoCategories.list: the list is tiny, effectively frozen, and region
 * dependent in ways that only add failure modes here. These are the ones a live stream plausibly uses; the
 * blank entry means "leave whatever the broadcast already has".
 */
const YT_CATEGORIES = [
    ['', 'Keep current'],
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
const ytCategoryName = (id) => (YT_CATEGORIES.find(([key]) => key === String(id || '')) || [])[1] || '';

/* The website's limits (templateFields.js), so a template that saves here also saves there. */
const TWITCH_TITLE_MAX = 140;
const YOUTUBE_TITLE_MAX = 100;
const TWITCH_TAGS_MAX = 10;
const TWITCH_TAG_LEN = 25;
const YOUTUBE_TAGS_CHARS = 500;
const SAVE_DELAY_MS = 600;
const FLASH_MS = 2200;
const UNDO_MS = 7000;

// Static markup of our own (never user data), so innerHTML is safe for these.
const TPL_ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    spin: '<span class="plan__spin" aria-hidden="true"></span>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

/** Twitch box art at a size; null without a category id. */
const boxArtUrl = (gameId, w, h) => (gameId ? `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(gameId)}-${w}x${h}.jpg` : null);

const csvToList = (csv) => String(csv || '').split(',').map((v) => v.trim()).filter(Boolean);

/** The one line under a template's name: what it sets, the same words as the website's list. */
function summaryOf(t) {
    if (t.platform === 'YOUTUBE') {
        return [ytCategoryName(t.youtubeCategoryId), t.youtubeTitle].filter(Boolean).join(' · ');
    }
    const category = t.twitchCategory && t.twitchCategoryYear ? `${t.twitchCategory} (${t.twitchCategoryYear})` : t.twitchCategory;
    return [category, t.twitchTitle].filter(Boolean).join(' · ');
}

/** The reason the server gave (a 400 is {"message"}), or a plain fallback. */
function reasonOf(result, fallback) {
    if (result && typeof result.error === 'string') {
        try {
            const parsed = JSON.parse(result.error);
            if (parsed && parsed.message) return parsed.message;
        } catch (_) { /* not JSON */ }
        if (result.error === 'not_connected') return 'Connect LBCBot first.';
    }
    return fallback;
}

let templates = [];
/** The template open in the editor; null shows the "pick or make one" state. */
let selectedTemplateId = null;
let linkedPlatforms = [];
/** Per-template Apply feedback: { state: 'busy' | 'ok' | 'error', message } — drawn on the row and the editor. */
const applyStates = new Map();
/** The editor's working copy, so autosave and the list read the same thing. */
let draft = null;
let saveTimer = null;
let saving = Promise.resolve();
let undoTimer = null;
let undoTemplate = null;

/* ---------- small DOM helpers */

function tplEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function iconButton(className, title, icon) {
    const button = tplEl('button', className);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = icon;
    return button;
}

/** A 56x32 slot: box art for a Twitch category, otherwise the platform's mark on a tile. */
function thumbFor(t) {
    const wrap = tplEl('span', 'plan__thumbwrap');
    const slot = tplEl('span', 'plan__thumb');
    const art = t.platform !== 'YOUTUBE' && boxArtUrl(t.twitchCategoryId, 48, 64);
    if (art) {
        slot.classList.add('is-art');
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = art;
        // A blocked or missing picture falls back to the tile rather than a broken-image box.
        img.addEventListener('error', () => {
            slot.classList.remove('is-art');
            slot.innerHTML = ICON[(t.platform || 'TWITCH').toLowerCase()] || TPL_ICON.grid;
        });
        slot.appendChild(img);
    } else {
        slot.classList.add(`is-${(t.platform || 'twitch').toLowerCase()}`);
        slot.innerHTML = ICON[(t.platform || 'TWITCH').toLowerCase()] || TPL_ICON.grid;
    }
    wrap.appendChild(slot);
    // With both platforms linked, a small badge says which one; with one, that would be noise.
    if (linkedPlatforms.length > 1 && t.platform && art) {
        const badge = tplEl('span', `plan__pfbadge plan__pfbadge--${t.platform.toLowerCase()}`);
        badge.title = PLATFORM_LABELS[t.platform] || t.platform;
        badge.innerHTML = ICON[t.platform.toLowerCase()] || '';
        wrap.appendChild(badge);
    }
    return wrap;
}

/** Apply's square button (rows) or labelled pill (editor): play → spinner → tick or cross, then back. */
function drawApply(button, id, labelled) {
    const st = applyStates.get(id);
    const state = st ? st.state : 'idle';
    button.className = `plan__apply${labelled ? ' plan__apply--label' : ''} is-${state}`;
    button.disabled = state === 'busy';
    const icon = { idle: TPL_ICON.play, busy: TPL_ICON.spin, ok: TPL_ICON.check, error: TPL_ICON.cross }[state];
    button.innerHTML = icon;
    if (labelled) button.appendChild(tplEl('span', null, state === 'ok' ? 'Applied' : 'Apply'));
    const word = { idle: 'Apply to your channel now', busy: 'Applying…', ok: 'Applied', error: 'Could not apply' }[state];
    button.title = word;
    button.setAttribute('aria-label', word);
}

/* ---------- the list */

function renderTemplateList() {
    const list = el('template-list');
    list.textContent = '';
    const count = el('template-count');
    count.hidden = templates.length === 0;
    count.textContent = String(templates.length);

    if (!templates.length) {
        // The website's ghost row: where the first template will go, and the way to make it.
        const li = tplEl('li', 'plan__ghost');
        const button = tplEl('button', 'plan__ghostbtn');
        button.type = 'button';
        const slot = tplEl('span', 'plan__ghostthumb');
        slot.innerHTML = TPL_ICON.plus;
        button.append(slot, tplEl('span', 'plan__ghostlabel', 'New template'));
        button.addEventListener('click', (event) => onNewTemplate(event, button));
        li.appendChild(button);
        list.appendChild(li);
        return;
    }

    templates.forEach((t) => {
        const id = t.streamTemplateId;
        const shown = id === selectedTemplateId && draft ? draft : t;
        const li = tplEl('li', `plan__row${id === selectedTemplateId ? ' is-selected' : ''}`);
        li.dataset.platform = (shown.platform || 'TWITCH').toLowerCase();

        const main = tplEl('button', 'plan__rowmain');
        main.type = 'button';
        const text = tplEl('span', 'plan__rowtext');
        text.appendChild(tplEl('span', 'plan__name', shown.name || 'Untitled'));
        const st = applyStates.get(id);
        if (st && st.state === 'error') {
            text.appendChild(tplEl('span', 'plan__sub is-error', st.message));
        } else {
            text.appendChild(tplEl('span', 'plan__sub', summaryOf(shown) || 'Keeps everything as it is'));
        }
        main.append(thumbFor(shown), text);
        main.addEventListener('click', () => selectTemplate(id));

        const apply = tplEl('button');
        apply.type = 'button';
        drawApply(apply, id, false);
        apply.addEventListener('click', () => applyTemplate(id));

        li.append(main, apply);
        list.appendChild(li);
    });
}

/* ---------- the editor */

/** Which platform's fields the editor shows: the template's own (one platform per template, as on the website). */
function editorPlatform(template) {
    if (template && template.platform) return template.platform;
    return linkedPlatforms[0] || 'TWITCH';
}

function setTemplateStatus(message) {
    const node = el('template-status');
    node.textContent = message || '';
    node.hidden = !message;
}

function setSaveState(state, message) {
    const node = el('template-save-state');
    node.className = `plan__save${state ? ` is-${state}` : ''}`;
    node.innerHTML = state === 'saved' ? TPL_ICON.check : state === 'error' ? TPL_ICON.cross : '';
    node.title = { saving: 'Saving…', saved: 'Saved', error: message || 'Could not save' }[state] || '';
    if (state === 'saved') {
        setTimeout(() => {
            if (node.classList.contains('is-saved')) setSaveState(null);
        }, FLASH_MS);
    }
}

function counter(id, used, max) {
    const node = el(id);
    node.textContent = `${used}/${max}`;
    node.classList.toggle('is-over', used > max);
}

function updateCounters() {
    if (!draft) return;
    counter('tw-title-count', (draft.twitchTitle || '').length, TWITCH_TITLE_MAX);
    counter('yt-title-count', (draft.youtubeTitle || '').length, YOUTUBE_TITLE_MAX);
    counter('tw-tags-count', csvToList(draft.twitchTags).length, TWITCH_TAGS_MAX);
    counter('yt-tags-count', csvToList(draft.youtubeTags).join(',').length, YOUTUBE_TAGS_CHARS);
}

function fillTemplateForm(template) {
    draft = template ? { ...template } : null;
    el('template-empty').hidden = !!draft;
    el('template-edbody').hidden = !draft;
    clearTimeout(saveTimer);
    setSaveState(null);
    setTemplateStatus('');
    closeCategoryMenu();
    if (!draft) return;

    const platform = editorPlatform(draft);
    el('tpl-twitch').hidden = platform !== 'TWITCH';
    el('tpl-youtube').hidden = platform !== 'YOUTUBE';
    const mark = el('template-platform');
    mark.innerHTML = ICON[platform.toLowerCase()] || '';
    mark.className = `plan__edplatform plan__edplatform--${platform.toLowerCase()}`;
    mark.title = PLATFORM_LABELS[platform] || platform;
    // One platform linked: no need to say which.
    mark.hidden = linkedPlatforms.length < 2;

    el('template-name').value = draft.name || '';
    el('tw-title').value = draft.twitchTitle || '';
    el('yt-title').value = draft.youtubeTitle || '';
    el('yt-description').value = draft.youtubeDescription || '';
    el('yt-category').value = draft.youtubeCategoryId || '';
    el('yt-language').value = draft.youtubeLanguage || '';
    el('yt-synthetic').checked = Boolean(draft.youtubeSyntheticMedia);
    renderCategory();
    twitchTags.render();
    youtubeTags.render();
    updateCounters();
    drawApply(el('template-apply'), draft.streamTemplateId, true);
}

function selectTemplate(id) {
    if (id === selectedTemplateId) return;
    flushSave();
    selectedTemplateId = id;
    fillTemplateForm(templates.find((t) => t.streamTemplateId === id) || null);
    renderTemplateList();
}

/* ---------- autosave */

/** Blank strings become null, which the server reads as "keep what is on the channel". */
const blankToNull = (v) => {
    const s = v == null ? '' : String(v).trim();
    return s === '' ? null : s;
};

/**
 * The wire shape: the whole template as loaded, with the fields this page edits laid over it. Starting from the
 * loaded template keeps what only the website edits (language, content labels, delay) instead of wiping it.
 */
function wireTemplate(t) {
    return {
        ...t,
        name: blankToNull(t.name) || 'Untitled',
        twitchTitle: blankToNull(t.twitchTitle),
        twitchCategory: blankToNull(t.twitchCategory),
        twitchCategoryId: blankToNull(t.twitchCategoryId),
        twitchTags: blankToNull(t.twitchTags),
        youtubeTitle: blankToNull(t.youtubeTitle),
        youtubeDescription: blankToNull(t.youtubeDescription),
        youtubeCategoryId: blankToNull(t.youtubeCategoryId),
        youtubeTags: blankToNull(t.youtubeTags),
        youtubeLanguage: blankToNull(t.youtubeLanguage),
        // Never offered in the UI — see the hint in the pane.
        youtubeMadeForKids: false,
        youtubeSyntheticMedia: Boolean(t.youtubeSyntheticMedia),
    };
}

/** An edit: kept in the draft, shown in the list at once, saved a moment after typing stops. */
function editDraft(patch) {
    if (!draft) return;
    Object.assign(draft, patch);
    updateCounters();
    renderTemplateList();
    clearTimeout(saveTimer);
    setSaveState('saving');
    saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
}

/** Save now if anything is waiting (switching template, leaving the pane, applying). Saves run one at a time. */
function flushSave() {
    if (!saveTimer || !draft) return saving;
    clearTimeout(saveTimer);
    saveTimer = null;
    const snapshot = { ...draft };
    const id = snapshot.streamTemplateId;
    saving = saving.then(async () => {
        const result = await window.lbcbot.saveStreamTemplate(id, wireTemplate(snapshot));
        const stillOpen = draft && draft.streamTemplateId === id;
        if (!result || !result.ok) {
            if (stillOpen) setSaveState('error', reasonOf(result, 'Could not save — see Activity.'));
            if (stillOpen) setTemplateStatus(reasonOf(result, 'Could not save — see Activity.'));
            return;
        }
        const saved = result.data || snapshot;
        templates = templates.map((t) => (t.streamTemplateId === id ? { ...t, ...saved } : t));
        if (stillOpen) {
            // Keep what was typed since this save left; take the server's copy for what it changes (cleaned tags).
            if (!saveTimer) setSaveState('saved');
            setTemplateStatus('');
        }
        renderTemplateList();
    });
    return saving;
}

/* ---------- category picker (Twitch) */

let categoryTimer = null;
let categoryResults = [];
let categoryCursor = -1;
let categorySeq = 0;

function renderCategory() {
    const picked = el('tw-category-picked');
    const clear = el('tw-category-clear');
    const search = el('tw-category-search');
    const has = draft && draft.twitchCategory;
    picked.hidden = !has;
    clear.hidden = !has;
    search.hidden = !!has;
    el('tw-category').value = '';
    picked.textContent = '';
    if (!has) return;
    const art = boxArtUrl(draft.twitchCategoryId, 36, 48);
    const slot = tplEl('span', 'plan__catart');
    if (art) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = art;
        img.addEventListener('error', () => { slot.innerHTML = TPL_ICON.grid; });
        slot.appendChild(img);
    } else {
        slot.innerHTML = TPL_ICON.grid;
    }
    const label = draft.twitchCategoryYear ? `${draft.twitchCategory} (${draft.twitchCategoryYear})` : draft.twitchCategory;
    picked.append(slot, tplEl('span', 'plan__catname', label));
    picked.title = 'Change the category';
}

function openCategorySearch() {
    el('tw-category-picked').hidden = true;
    el('tw-category-clear').hidden = true;
    el('tw-category-search').hidden = false;
    const input = el('tw-category');
    input.value = '';
    input.focus();
}

function closeCategoryMenu() {
    const menu = el('tw-category-menu');
    menu.hidden = true;
    menu.textContent = '';
    el('tw-category').setAttribute('aria-expanded', 'false');
    categoryResults = [];
    categoryCursor = -1;
}

function drawCategoryMenu(message) {
    const menu = el('tw-category-menu');
    menu.textContent = '';
    if (message) {
        menu.appendChild(tplEl('li', 'plan__catnote', message));
    }
    // Two categories with one name (Spyro 1998 vs 2018) can only be told apart by their pictures, so say "this one".
    categoryResults.forEach((game, index) => {
        const li = tplEl('li', `plan__catopt${index === categoryCursor ? ' is-cursor' : ''}`);
        li.setAttribute('role', 'option');
        const slot = tplEl('span', 'plan__catart plan__catart--big');
        const url = game.box_art_url ? game.box_art_url.replace('{width}', '48').replace('{height}', '64') : boxArtUrl(game.id, 48, 64);
        if (url) {
            const img = document.createElement('img');
            img.alt = '';
            img.src = url;
            slot.appendChild(img);
        }
        li.append(slot, tplEl('span', 'plan__catname', game.name));
        // mousedown, not click: the input's blur would close the menu before a click lands.
        li.addEventListener('mousedown', (event) => {
            event.preventDefault();
            pickCategory(game);
        });
        menu.appendChild(li);
    });
    menu.hidden = !message && !categoryResults.length;
    el('tw-category').setAttribute('aria-expanded', String(!menu.hidden));
}

function pickCategory(game) {
    closeCategoryMenu();
    editDraft({ twitchCategory: game.name, twitchCategoryId: game.id, twitchCategoryYear: null });
    renderCategory();
}

function onCategoryInput() {
    const typed = el('tw-category').value.trim();
    clearTimeout(categoryTimer);
    if (typed.length < 2) {
        el('tw-category-spin').hidden = true;
        closeCategoryMenu();
        return;
    }
    el('tw-category-spin').hidden = false;
    const seq = ++categorySeq;
    // Debounced: this is a Twitch API call per keystroke otherwise.
    categoryTimer = setTimeout(async () => {
        const results = await window.lbcbot.searchTwitchCategories(typed);
        if (seq !== categorySeq) return; // a later keystroke owns the menu now
        el('tw-category-spin').hidden = true;
        categoryResults = (results || []).slice(0, 8);
        categoryCursor = categoryResults.length ? 0 : -1;
        drawCategoryMenu(categoryResults.length ? null : 'No matching category');
    }, 300);
}

function onCategoryKey(event) {
    const menu = el('tw-category-menu');
    if (event.key === 'Escape') {
        if (!menu.hidden) {
            closeCategoryMenu();
        } else if (draft && draft.twitchCategory) {
            renderCategory();
        }
        return;
    }
    if (menu.hidden || !categoryResults.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        categoryCursor = (categoryCursor + step + categoryResults.length) % categoryResults.length;
        drawCategoryMenu(null);
    } else if (event.key === 'Enter' && categoryCursor >= 0) {
        event.preventDefault();
        pickCategory(categoryResults[categoryCursor]);
    }
}

/* ---------- tags as chips */

/**
 * One chip box per platform. Typing a comma or Enter turns the text into a chip; Backspace in an empty box removes
 * the last; pasting "a, b, c" makes three. Twitch's rules are applied as you type (letters and numbers, 25 long,
 * 10 at most), the same cleaning the website does.
 */
function tagBox({ boxId, field, clean, limitReached }) {
    const box = el(boxId);
    const input = tplEl('input', 'plan__taginput');
    input.type = 'text';
    input.id = `${boxId}-input`;
    input.spellcheck = false;
    input.autocomplete = 'off';

    const list = () => csvToList(draft && draft[field]);
    const save = (tags) => editDraft({ [field]: tags.join(', ') });

    function add(raw) {
        const tags = list();
        raw.split(',').map(clean).filter(Boolean).forEach((tag) => {
            if (limitReached(tags, tag)) return;
            if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
        });
        save(tags);
        input.value = '';
        render();
        input.focus();
    }

    function render() {
        box.textContent = '';
        list().forEach((tag, index) => {
            const chip = tplEl('span', 'plan__chip');
            chip.appendChild(tplEl('span', null, tag));
            const remove = iconButton('plan__chipx', `Remove ${tag}`, TPL_ICON.x);
            remove.addEventListener('click', () => {
                const tags = list();
                tags.splice(index, 1);
                save(tags);
                render();
                input.focus();
            });
            chip.appendChild(remove);
            box.appendChild(chip);
        });
        input.placeholder = list().length ? '' : 'Keep current tags';
        box.appendChild(input);
    }

    input.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ',') && input.value.trim()) {
            event.preventDefault();
            add(input.value);
        } else if (event.key === 'Backspace' && !input.value && list().length) {
            const tags = list();
            tags.pop();
            save(tags);
            render();
            input.focus();
        }
    });
    input.addEventListener('paste', (event) => {
        const text = (event.clipboardData || window.clipboardData).getData('text');
        if (text && text.includes(',')) {
            event.preventDefault();
            add(text);
        }
    });
    // A tag typed and left without a comma still counts.
    input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); });
    box.addEventListener('mousedown', (event) => {
        if (event.target === box) {
            event.preventDefault();
            input.focus();
        }
    });
    return { render };
}

const twitchTags = tagBox({
    boxId: 'tw-tags',
    field: 'twitchTags',
    clean: (raw) => raw.replace(/[^\p{L}\p{N}]/gu, '').slice(0, TWITCH_TAG_LEN),
    limitReached: (tags) => tags.length >= TWITCH_TAGS_MAX,
});
const youtubeTags = tagBox({
    boxId: 'yt-tags',
    field: 'youtubeTags',
    clean: (raw) => raw.trim().replace(/[<>]/g, ''),
    limitReached: (tags, tag) => [...tags, tag].join(',').length > YOUTUBE_TAGS_CHARS,
});

/* ---------- actions */

async function applyTemplate(id) {
    const current = applyStates.get(id);
    if (current && current.state === 'busy') return;
    // Apply what is on screen, not what was last saved.
    if (draft && draft.streamTemplateId === id) await flushSave();
    applyStates.set(id, { state: 'busy' });
    redrawApply(id);
    const result = await window.lbcbot.applyStreamTemplate(id);
    let next;
    if (!result || !result.ok) {
        next = { state: 'error', message: reasonOf(result, 'Could not apply — see Activity.') };
    } else {
        /*
         * One platform per template, so one outcome matters; but read both, not an overall verdict, in case a legacy
         * template still carries the two.
         */
        const outcomes = ['twitch', 'youtube'].map((p) => result.data && result.data[p]).filter((o) => o && o.attempted);
        const failed = outcomes.filter((o) => !o.ok);
        next = !outcomes.length
            ? { state: 'error', message: 'Nothing in this template to apply.' }
            : failed.length
                ? { state: 'error', message: failed.map((o) => o.message).join(' ') }
                : { state: 'ok' };
    }
    applyStates.set(id, next);
    redrawApply(id);
    if (next.state === 'ok') {
        setTimeout(() => {
            if ((applyStates.get(id) || {}).state === 'ok') {
                applyStates.delete(id);
                redrawApply(id);
            }
        }, FLASH_MS);
    }
}

function redrawApply(id) {
    renderTemplateList();
    if (draft && draft.streamTemplateId === id) {
        drawApply(el('template-apply'), id, true);
        const st = applyStates.get(id);
        setTemplateStatus(st && st.state === 'error' ? st.message : '');
    }
}

async function createTemplate(body, focusName) {
    const result = await window.lbcbot.saveStreamTemplate(null, body);
    if (!result || !result.ok || !result.data) {
        setTemplateStatus(reasonOf(result, 'Could not make the template — see Activity.'));
        return null;
    }
    await refreshTemplates(result.data.streamTemplateId);
    if (focusName) {
        el('template-name').focus();
        el('template-name').select();
    }
    return result.data;
}

/** New: one click with one platform linked; with two, a small menu picks which (as on the website). */
function onNewTemplate(event, anchor) {
    const menu = el('template-new-menu');
    if (linkedPlatforms.length < 2) {
        flushSave();
        createTemplate({ name: 'New template', platform: linkedPlatforms[0] || 'TWITCH' }, true);
        return;
    }
    if (!menu.hidden) {
        menu.hidden = true;
        return;
    }
    menu.textContent = '';
    linkedPlatforms.forEach((platform) => {
        const item = tplEl('button', `plan__menuitem plan__menuitem--${platform.toLowerCase()}`);
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.innerHTML = ICON[platform.toLowerCase()] || '';
        item.appendChild(tplEl('span', null, `${PLATFORM_LABELS[platform]} template`));
        item.addEventListener('click', () => {
            menu.hidden = true;
            flushSave();
            createTemplate({ name: 'New template', platform }, true);
        });
        menu.appendChild(item);
    });
    // Under whichever + was pressed: the header's, or the empty list's ghost row.
    menu.classList.toggle('is-ghost', anchor !== el('template-new'));
    menu.hidden = false;
    event.stopPropagation();
}

async function duplicateTemplate() {
    if (!draft) return;
    await flushSave();
    const copy = wireTemplate(draft);
    delete copy.streamTemplateId;
    delete copy.sortOrder;
    copy.name = `${draft.name || 'Untitled'} (copy)`.slice(0, 80);
    const made = await createTemplate(copy, false);
    if (made) setSaveState('saved');
}

/** Delete at once, then offer Undo along the bottom — no confirm for something that can be put back. */
async function deleteTemplate() {
    if (!draft) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const gone = { ...draft };
    const result = await window.lbcbot.deleteStreamTemplate(gone.streamTemplateId);
    if (!result || !result.ok) {
        setTemplateStatus(reasonOf(result, 'Could not delete — see Activity.'));
        return;
    }
    applyStates.delete(gone.streamTemplateId);
    selectedTemplateId = null;
    fillTemplateForm(null);
    await refreshTemplates(null);
    undoTemplate = gone;
    el('template-snack-text').textContent = `Deleted “${gone.name || 'Untitled'}”`;
    el('template-snack').hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, UNDO_MS);
}

function hideUndo() {
    clearTimeout(undoTimer);
    el('template-snack').hidden = true;
    undoTemplate = null;
}

async function undoDelete() {
    const gone = undoTemplate;
    hideUndo();
    if (!gone) return;
    // Back where it was in the list: the old sort order goes with it.
    const body = wireTemplate(gone);
    delete body.streamTemplateId;
    await createTemplate(body, false);
}

async function refreshTemplates(selectId) {
    const loaded = await window.lbcbot.getStreamTemplates();
    templates = Array.isArray(loaded) ? loaded : [];
    if (selectId !== undefined) {
        selectedTemplateId = selectId;
    }
    if (selectedTemplateId && !templates.some((t) => t.streamTemplateId === selectedTemplateId)) {
        selectedTemplateId = null;
    }
    // A refresh while typing keeps what was typed: the draft is newer than the server's copy until it saves.
    const keepDraft = saveTimer && draft && draft.streamTemplateId === selectedTemplateId;
    if (!keepDraft) {
        fillTemplateForm(templates.find((t) => t.streamTemplateId === selectedTemplateId) || null);
    }
    renderTemplateList();
}

function wireTemplates() {
    const ytCategory = el('yt-category');
    YT_CATEGORIES.forEach(([id, label]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        ytCategory.appendChild(option);
    });

    el('template-new').addEventListener('click', (event) => onNewTemplate(event, el('template-new')));
    document.addEventListener('click', (event) => {
        const menu = el('template-new-menu');
        if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') el('template-new-menu').hidden = true;
    });

    el('template-name').addEventListener('input', (e) => editDraft({ name: e.target.value }));
    el('tw-title').addEventListener('input', (e) => editDraft({ twitchTitle: e.target.value.replace(/\n/g, ' ') }));
    el('yt-title').addEventListener('input', (e) => editDraft({ youtubeTitle: e.target.value.replace(/\n/g, ' ') }));
    // A title is one line: Enter would put a newline in it, so it does nothing.
    ['tw-title', 'yt-title', 'template-name'].forEach((id) => {
        el(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    });
    el('yt-description').addEventListener('input', (e) => editDraft({ youtubeDescription: e.target.value }));
    el('yt-category').addEventListener('change', (e) => editDraft({ youtubeCategoryId: e.target.value }));
    el('yt-language').addEventListener('input', (e) => editDraft({ youtubeLanguage: e.target.value }));
    el('yt-synthetic').addEventListener('change', (e) => editDraft({ youtubeSyntheticMedia: e.target.checked }));

    el('tw-category').addEventListener('input', onCategoryInput);
    el('tw-category').addEventListener('keydown', onCategoryKey);
    el('tw-category').addEventListener('blur', () => {
        setTimeout(() => {
            closeCategoryMenu();
            el('tw-category-spin').hidden = true;
            // Left without picking: show the category it already had.
            if (draft && draft.twitchCategory) renderCategory();
        }, 0);
    });
    el('tw-category-picked').addEventListener('click', openCategorySearch);
    el('tw-category-clear').addEventListener('click', () => {
        editDraft({ twitchCategory: null, twitchCategoryId: null, twitchCategoryYear: null });
        renderCategory();
    });

    el('template-apply').addEventListener('click', () => { if (draft) applyTemplate(draft.streamTemplateId); });
    el('template-duplicate').addEventListener('click', duplicateTemplate);
    el('template-delete').addEventListener('click', deleteTemplate);
    el('template-undo').addEventListener('click', undoDelete);

    // Leaving the pane or the app saves what is waiting.
    window.addEventListener('beforeunload', () => { flushSave(); });
    document.querySelectorAll('.nav__item').forEach((b) => b.addEventListener('click', () => flushSave()));
}

function wire() {
    wireAccountMenu();
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
    el('obs-rename').addEventListener('click', startObsRename);
    el('obs-where').addEventListener('dblclick', startObsRename);
    el('obs-rename-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') endObsRename(true);
        if (event.key === 'Escape') endObsRename(false);
    });
    el('obs-rename-input').addEventListener('blur', () => endObsRename(true));
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
