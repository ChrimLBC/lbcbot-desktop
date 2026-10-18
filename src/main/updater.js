'use strict';

const { app } = require('electron');

/**
 * In-app updates, so an installed copy is not frozen at whatever version it was downloaded as.
 *
 * <h2>How it resolves a new version</h2>
 *
 * electron-builder writes a `latest.yml` next to the installer at build time — version, file name, size and
 * sha512 — and publishes it as a release asset. electron-updater fetches that file from the newest GitHub
 * release, compares its version to this app's, and downloads the installer only if it is higher. The checksum in
 * `latest.yml` is verified before anything is run, which is the only integrity check an unsigned build gets.
 *
 * <p><b>`latest.yml` is not optional and is easy to leave behind.</b> Publishing only the `.exe` — which the
 * release workflow did at first — produces releases that look complete and are undiscoverable to every installed
 * copy: the updater 404s on the metadata and reports "no update available" forever. The workflow uploads both.
 *
 * <h2>Why the version has to come from the tag</h2>
 *
 * The comparison is against the version compiled into the app from `package.json`. Tagging `v1.0.1` without
 * bumping `package.json` ships an app that still calls itself 1.0.0, so it compares 1.0.0 to 1.0.0 and stays
 * put — a release that exists on GitHub and reaches nobody. That is exactly what happened to v1.0.1, so the
 * workflow now writes the tag's version into `package.json` before building and the two cannot drift.
 *
 * <h2>Windows only, for now</h2>
 *
 * NSIS updates work unsigned: SmartScreen warns on the downloaded installer the same way it warns on the first
 * one, and the user can proceed. macOS is different in kind — Squirrel.Mac refuses to apply an update to an app
 * that is not code-signed, so a mac build cannot self-update until there is a Developer ID certificate. Rather
 * than fail obscurely there, this stays off anywhere but Windows and says so.
 *
 * <h2>Nothing installs itself mid-stream</h2>
 *
 * The download is automatic, the restart is not. This app is run while live — a self-restarting dashboard
 * closing the window a streamer is reading is worse than being a version behind for an hour. The renderer gets
 * "ready", shows a Restart button, and the update otherwise applies the next time the app quits normally.
 */

/** Six hours. Long enough to be invisible, short enough that a fix lands the same stream day. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

class Updater {
    /**
     * @param onLog    line logger, shared with the rest of the app
     * @param onStatus called with { state, version?, percent?, error? } — the renderer's whole view of this
     */
    constructor({ onLog, onStatus }) {
        this.log = onLog || (() => {});
        this.emit = onStatus || (() => {});
        this.timer = null;
        this.updater = null;
        // Last status, so a renderer that mounts after the check finished still learns about a ready update.
        this.status = { state: 'idle', currentVersion: app.getVersion() };
    }

    /** True when updates can actually be applied here — see the Windows-only note above. */
    static get supported() {
        return process.platform === 'win32' && app.isPackaged;
    }

    setStatus(status) {
        this.status = { ...status, currentVersion: app.getVersion() };
        this.emit(this.status);
    }

    start() {
        if (!Updater.supported) {
            // Two genuinely different reasons, and the difference matters to anyone reading the log: a dev run is
            // expected to say this, a mac build is a limitation worth knowing about.
            this.setStatus({
                state: 'unsupported',
                reason: app.isPackaged
                    ? 'Automatic updates need a code-signed build on this platform. Download the latest version '
                        + 'from the website instead.'
                    : 'Running from source — updates only apply to an installed copy.',
            });
            return;
        }

        // Required lazily so a dev run with no electron-updater installed still starts, and so the module is not
        // loaded at all on platforms that cannot use it.
        // eslint-disable-next-line global-require
        const { autoUpdater } = require('electron-updater');
        this.updater = autoUpdater;

        autoUpdater.autoDownload = true;
        // Apply on the next normal quit as well as on the Restart button. Quitting is already the user ending
        // their session, so finishing the install there interrupts nothing — what must never happen is the app
        // restarting itself while a dashboard is on screen, and that is what autoDownload-without-autoInstall
        // would not have prevented anyway.
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.logger = { info: (m) => this.log(`Update: ${m}`), warn: (m) => this.log(`Update: ${m}`), error: (m) => this.log(`Update error: ${m}`), debug: () => {} };

        autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }));
        autoUpdater.on('update-not-available', () => this.setStatus({ state: 'current' }));
        autoUpdater.on('update-available', (info) => {
            this.log(`Update ${info.version} available — downloading.`);
            this.setStatus({ state: 'downloading', version: info.version, percent: 0 });
        });
        autoUpdater.on('download-progress', (p) => this.setStatus({
            state: 'downloading',
            version: this.status.version,
            percent: Math.round(p.percent || 0),
        }));
        autoUpdater.on('update-downloaded', (info) => {
            this.log(`Update ${info.version} is ready — it installs when you restart.`);
            this.setStatus({ state: 'ready', version: info.version });
        });
        autoUpdater.on('error', (error) => {
            // Never fatal and never a dialog: a failed check is not the user's problem and the app works fine
            // without it. It goes in the log and the pane, and the next check tries again.
            this.log(`Could not check for updates: ${(error && error.message) || error}`);
            this.setStatus({ state: 'error', error: (error && error.message) || String(error) });
        });

        this.check();
        this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    }

    check() {
        if (!this.updater) return;
        // An already-downloaded update has nothing left to check for, and re-checking would reset the pane from
        // "ready to restart" back to "checking" for no reason.
        if (this.status.state === 'ready') return;
        this.updater.checkForUpdates().catch(() => { /* reported through the error event above */ });
    }

    /** Apply a downloaded update now. No-op unless one is actually ready — quitAndInstall would just quit. */
    restartAndInstall() {
        if (!this.updater || this.status.state !== 'ready') {
            return { ok: false, error: 'No update is ready yet.' };
        }
        // isSilent false so the NSIS installer shows itself; isForceRunAfter so the app comes back up, which is
        // the only reason a streamer agreed to the restart.
        setImmediate(() => this.updater.quitAndInstall(false, true));
        return { ok: true };
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = { Updater };
