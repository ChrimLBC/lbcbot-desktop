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
}

/**
 * Sidebar navigation.
 *
 * Wired generically off `data-pane` so adding a section is one nav button and one `.pane` — nothing here needs
 * to learn its name. Deliberately not persisted: a launch should always open on Status, because that is where
 * you act when something failed to connect.
 */
function showPane(name) {
    const pane = el(`pane-${name}`);
    if (!pane) return;
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

function applyState(state) {
    if (!state) return;
    if (state.settings) {
        // Only write inputs the user is not currently editing, or typing gets clobbered by a push update.
        const assign = (node, value) => {
            if (document.activeElement !== node) node.value = value ?? '';
        };
        assign(el('api-url'), state.settings.apiUrl);
        assign(el('site-url'), state.settings.siteUrl || 'https://lbcbot.devsoperative.com');
        assign(el('obs-url'), state.settings.obsUrl);
        el('forward-events').checked = state.settings.forwardObsEvents !== false;
        el('auto-connect').checked = state.settings.autoConnectObs !== false;
    }
    setStatus('lbc', state.lbcbotConnected);
    setStatus('obs', state.obsConnected);
    if (state.lbcbotConnected) el('device-code').textContent = '';
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
        button.className = 'primary';
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

function wire() {
    el('lbc-connect').addEventListener('click', async () => {
        el('device-code').textContent = 'Opening your browser…';
        await window.lbcbot.connectLbcbot();
        await refreshOverlays();
        await refreshDashboards();
    });
    el('lbc-disconnect').addEventListener('click', () => window.lbcbot.disconnectLbcbot());

    el('obs-connect').addEventListener('click', async () => {
        await window.lbcbot.setObsPassword(el('obs-password').value);
        await window.lbcbot.connectObs();
        await refreshOverlays();
    });
    el('obs-disconnect').addEventListener('click', () => window.lbcbot.disconnectObs());

    el('refresh-overlays').addEventListener('click', refreshOverlays);

    el('refresh-dashboards').addEventListener('click', refreshDashboards);
    el('open-dashboard').addEventListener('click', () => {
        // An empty value means "no specific dashboard" — the main process then loads the picker page instead.
        window.lbcbot.openDashboard(el('dashboard-select').value || null);
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

    window.lbcbot.onState(applyState);
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
    const { logLines } = await window.lbcbot.getState();
    (logLines || []).forEach(appendLog);
    await refreshOverlays();
    await refreshDashboards();
})();
