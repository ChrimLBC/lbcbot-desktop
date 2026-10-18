'use strict';

const { shell } = require('electron');
const store = require('./store');

/**
 * LBCBot API client for the desktop app, plus the STOMP subscription that receives OBS commands.
 *
 * Same credential model as the Stream Deck plugin: a long-lived opaque `lbc_dk_...` credential from the
 * device-authorization grant, exchanged at `POST /api/token` for a short-lived JWT. The credential goes in the
 * request BODY of that call — the path is permitAll, but Spring still rejects an `Authorization: Bearer` value it
 * cannot decode as a JWT, and an opaque credential never is.
 *
 * Being a Node process means no CORS applies, so none of the API's allowed-origin config is involved.
 */

const REFRESH_MARGIN_MS = 60_000;

class LbcBot {
    constructor({ onLog }) {
        this.onLog = onLog || (() => {});
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.userId = null;
        this.stompClient = null;
        this.onDeviceCommand = null;
        this.inFlightExchange = null;
    }

    baseUrl() {
        return (store.settings().apiUrl || '').replace(/\/+$/, '');
    }

    async token() {
        if (this.accessToken && Date.now() < this.tokenExpiresAt - REFRESH_MARGIN_MS) {
            return this.accessToken;
        }
        if (this.inFlightExchange) {
            return this.inFlightExchange;
        }
        this.inFlightExchange = this.exchange().finally(() => {
            this.inFlightExchange = null;
        });
        return this.inFlightExchange;
    }

    async exchange() {
        const credential = store.getCredential();
        if (!credential) {
            return null;
        }
        try {
            const response = await fetch(`${this.baseUrl()}/api/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: credential }),
            });
            if (!response.ok) {
                if (response.status === 401) {
                    // Revoked or rotated in the dashboard. Clear it so the UI asks for a reconnect instead of
                    // hammering a credential that can never work again.
                    this.onLog('LBCBot credential was rejected — reconnect required.');
                    store.setCredential(null);
                }
                return null;
            }
            const body = await response.json();
            this.accessToken = body.accessToken;
            this.tokenExpiresAt = Date.now() + (body.expiresIn || 3600) * 1000;
            this.userId = body.userId;
            return this.accessToken;
        } catch (error) {
            this.onLog(`Token exchange failed: ${error.message}`);
            return null;
        }
    }

    async request(method, path, body, retrying = false) {
        const token = await this.token();
        if (!token) {
            return { ok: false, status: 0, error: 'not_connected' };
        }
        try {
            const response = await fetch(`${this.baseUrl()}/api${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (response.status === 401 && !retrying) {
                this.accessToken = null;
                return this.request(method, path, body, true);
            }
            const text = await response.text();
            if (!response.ok) {
                return { ok: false, status: response.status, error: text };
            }
            return { ok: true, data: text ? JSON.parse(text) : null };
        } catch (error) {
            return { ok: false, status: 0, error: error.message };
        }
    }

    // ------------------------------------------------------------------ device authorization

    /** Start the device flow, open the browser at the approval page, and poll until approved. */
    async connect({ onCode }) {
        const base = this.baseUrl();
        const start = await fetch(`${base}/api/device/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientType: 'DESKTOP', name: 'Desktop app' }),
        });
        if (!start.ok) {
            throw new Error(`Could not start device authorization (HTTP ${start.status})`);
        }
        const grant = await start.json();
        if (onCode) {
            onCode(grant);
        }
        shell.openExternal(grant.verificationUriComplete);

        const intervalMs = Math.max(1, grant.interval || 5) * 1000;
        const deadline = Date.now() + (grant.expiresIn || 600) * 1000;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            const poll = await fetch(`${base}/api/device/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceCode: grant.deviceCode }),
            });
            const body = await poll.json().catch(() => ({}));
            if (poll.ok && body.credential) {
                store.setCredential(body.credential);
                this.accessToken = null;
                await this.token();
                return true;
            }
            // authorization_pending is the expected answer while the user decides; anything else ends the flow.
            if (body.error && body.error !== 'authorization_pending') {
                return false;
            }
        }
        return false;
    }

    disconnect() {
        store.setCredential(null);
        this.accessToken = null;
        this.userId = null;
        this.stopDeviceControl();
    }

    // ------------------------------------------------------------------ OBS commands in (STOMP)

    /**
     * Subscribe to `/topic/deviceControl/{userId}` to receive the OBS actions attached to triggers.
     *
     * SockJS + STOMP, the same stack the browser overlays use — the proxy exposes only a SockJS endpoint, so a raw
     * WebSocket would mean hand-rolling SockJS framing on top of STOMP. `sockjs-client` works unchanged in Node.
     *
     * The subscription authorization rule is that the destination's last path segment must equal the JWT subject, so
     * `userId` here must be the one the token exchange reported, not anything the user typed.
     */
    async startDeviceControl(onCommand) {
        this.onDeviceCommand = onCommand;
        const token = await this.token();
        if (!token || !this.userId) {
            return false;
        }
        this.stopDeviceControl();

        // Required lazily: sockjs-client touches browser globals at import time in some builds, so it must not be
        // loaded until a connection is actually wanted.
        const SockJS = require('sockjs-client');
        const { Client } = require('@stomp/stompjs');

        const wsUrl = `${this.baseUrl()}/ws/lbcbot`;
        const client = new Client({
            webSocketFactory: () => new SockJS(wsUrl, null, { transports: ['websocket', 'xhr-polling'] }),
            connectHeaders: { Authorization: `Bearer ${token}` },
            // Match the proxy's 10s/10s broker heartbeats. Mismatched values make Spring negotiate 0,0 — no
            // heartbeats at all — and a silently dead connection then looks subscribed forever.
            heartbeatIncoming: 10000,
            heartbeatOutgoing: 10000,
            reconnectDelay: 5000,
            debug: () => {},
        });

        client.onConnect = () => {
            this.onLog('Listening for OBS commands from LBCBot.');
            client.subscribe(`/topic/deviceControl/${this.userId}`, (message) => {
                try {
                    const payload = JSON.parse(message.body);
                    if (this.onDeviceCommand) {
                        this.onDeviceCommand(payload);
                    }
                } catch (error) {
                    this.onLog(`Ignored an unreadable device command: ${error.message}`);
                }
            });
        };
        client.onStompError = (frame) => this.onLog(`STOMP error: ${frame.headers?.message || 'unknown'}`);
        // A reconnect re-reads the token, because by then the old one may have expired.
        client.beforeConnect = async () => {
            const fresh = await this.token();
            client.connectHeaders = { Authorization: `Bearer ${fresh}` };
        };

        client.activate();
        this.stompClient = client;
        return true;
    }

    stopDeviceControl() {
        if (this.stompClient) {
            try {
                this.stompClient.deactivate();
            } catch (error) {
                // Deactivating an already-dead client is not worth surfacing.
            }
            this.stompClient = null;
        }
    }

    // ------------------------------------------------------------------ convenience calls

    getOverlays() {
        return this.request('GET', '/users/overlay');
    }

    /** The user's control dashboards — name + id, so the app can offer them by name in the window menu. */
    getDashboards() {
        return this.request('GET', '/users/dashboard');
    }

    createOverlayKey(overlayId, name) {
        return this.request('POST', '/users/credentials/overlay-key', { overlayId, name });
    }

    /**
     * Which streaming platforms this account has linked.
     *
     * Connections live on the ACCOUNT, not on this machine — the desktop app reads the state and sends people to
     * the website to change it, because the OAuth redirect_uri is registered to the site and the callback needs
     * the site's session to complete the link.
     */
    getPlatforms() {
        return this.request('GET', '/users/platforms');
    }

    // ------------------------------------------------------------------ stream templates

    /** Saved Twitch + YouTube metadata sets. Stored server-side, so they follow the account to any surface. */
    getStreamTemplates() {
        return this.request('GET', '/users/stream-template');
    }

    /** Create when `id` is null, update otherwise — the server takes the id from the path, never the body. */
    saveStreamTemplate(id, template) {
        return this.request('POST', id ? `/users/stream-template/${id}` : '/users/stream-template', template);
    }

    deleteStreamTemplate(id) {
        return this.request('DELETE', `/users/stream-template/${id}`);
    }

    /** Push a template to both platforms. Answers per-platform outcomes, not a single boolean. */
    applyStreamTemplate(id) {
        return this.request('POST', `/users/stream-template/${id}/apply`);
    }

    /** Fuzzy Twitch category search, so a template stores the game_id rather than a name to resolve later. */
    searchTwitchCategories(query) {
        return this.request('GET', `/users/twitch/categories?q=${encodeURIComponent(query)}`);
    }

    postObsEvent(payload) {
        return this.request('POST', '/users/obs/event', payload);
    }
}

module.exports = { LbcBot };
