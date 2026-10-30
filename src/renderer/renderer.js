'use strict';

/* Renderer: status and settings only. It has no credential, no network access and no OBS access — everything goes
   through the narrow bridge in src/preload/index.js. */

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
    // "Offline" rather than "Not connected": the rail is 200px and the longer label wrapped the pill onto two
    // lines. The dot carries the same meaning anyway, so the word only has to confirm it.
    setPill(el(`${name}-status`), on, 'Connected', 'Offline');
    el(`${name}-dot`).className = `dot ${on ? 'dot--on' : 'dot--off'}`;

    // Only offer what can happen now: Connect while offline, Disconnect while connected. ("Forget credential" stays
    // for LBCBot — a stored credential can exist whether or not it is currently connected.)
    const connectBtn = el(name === 'lbc' ? 'lbc-connect' : 'obs-connect');
    if (connectBtn) connectBtn.hidden = !!on;
    if (name === 'obs' && el('obs-disconnect')) el('obs-disconnect').hidden = !on;

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

let wasConnected = false;

function applyState(state) {
    if (!state) return;
    if (state.settings) {
        // Only write inputs the user is not currently editing, or typing gets clobbered by a push update.
        const assign = (node, value) => {
            if (document.activeElement !== node) node.value = value ?? '';
        };
        assign(el('api-url'), state.settings.apiUrl);
        assign(el('site-url'), state.settings.siteUrl);
        assign(el('obs-url'), state.settings.obsUrl);
        el('forward-events').checked = state.settings.forwardObsEvents !== false;
        el('auto-connect').checked = state.settings.autoConnectObs !== false;
    }
    // Coming online is when the account's lists first become readable, so read them then too.
    if (state.lbcbotConnected && !wasConnected) refreshAccountLists();
    wasConnected = !!state.lbcbotConnected;
    setStatus('lbc', state.lbcbotConnected);
    setStatus('obs', state.obsConnected);
    if (state.lbcbotConnected) el('device-code').textContent = '';
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
const PLATFORM_LABELS = { TWITCH: 'Twitch', YOUTUBE: 'YouTube' };

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
    el('lbc-connect').addEventListener('click', async () => {
        el('device-code').textContent = 'Opening your browser…';
        await window.lbcbot.connectLbcbot();
        await refreshOverlays();
        await refreshDashboards();
        await refreshPlatforms();
        await refreshTemplates();
    });

    el('refresh-platforms').addEventListener('click', refreshPlatforms);
    el('open-integrations').addEventListener('click', () => window.lbcbot.openIntegrations());
    el('lbc-disconnect').addEventListener('click', () => window.lbcbot.disconnectLbcbot());

    el('obs-connect').addEventListener('click', async () => {
        await window.lbcbot.setObsPassword(el('obs-password').value);
        await window.lbcbot.connectObs();
        await refreshOverlays();
    });
    el('obs-disconnect').addEventListener('click', () => window.lbcbot.disconnectObs());

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
        apiUrl: el('api-url').value.trim(),
        siteUrl: el('site-url').value.trim(),
        obsUrl: el('obs-url').value.trim(),
        forwardObsEvents: el('forward-events').checked,
        autoConnectObs: el('auto-connect').checked,
    });
    ['api-url', 'site-url', 'obs-url'].forEach((id) => el(id).addEventListener('change', persist));
    ['forward-events', 'auto-connect'].forEach((id) => el(id).addEventListener('change', persist));

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
    window.lbcbot.onObsStatus((status) => setStatus('obs', status.connected));
    window.lbcbot.onDeviceCode((grant) => {
        el('device-code').textContent =
            `Approve code ${grant.userCode} — your browser should have opened at ${grant.verificationUri}`;
    });
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
