'use strict';

const { shell } = require('electron');
const store = require('./store');
const { MAX_ACCOUNTS } = require('./accounts');

/**
 * LBCBot API client for the desktop app, plus the STOMP subscription that receives OBS and GreenSplit commands.
 *
 * Same credential model as the Stream Deck plugin: a long-lived opaque `lbc_dk_...` credential per account from the
 * device-authorization grant, exchanged at `POST /api/token` for a short-lived JWT. The credential goes in the
 * request BODY of that call — the path is permitAll, but Spring still rejects an `Authorization: Bearer` value it
 * cannot decode as a JWT, and an opaque credential never is.
 *
 * Being a Node process means no CORS applies, so none of the API's allowed-origin config is involved.
 */

const REFRESH_MARGIN_MS = 60_000;

/**
 * Several accounts (2026-11-20): the app holds one credential per account (store.js, accounts.js) and works as the
 * ACTIVE one. Everything here — the cached token, the STOMP subscription, every call — is that account's. A switch
 * (`useAccount`) drops the cached token and bumps `generation`, so an exchange still in flight for the account left
 * behind can never be taken as the new one's.
 */
class LbcBot {
    constructor({ onLog }) {
        this.onLog = onLog || (() => {});
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.userId = null;
        this.stompClient = null;
        this.onDeviceCommand = null;
        this.inFlightExchange = null;
        this.generation = 0;
        this.adding = null;
        this.addStarting = null;
    }

    baseUrl() {
        return store.endpoints().apiUrl;
    }

    async token() {
        if (this.accessToken && Date.now() < this.tokenExpiresAt - REFRESH_MARGIN_MS) {
            return this.accessToken;
        }
        const generation = this.generation;
        if (!this.inFlightExchange) {
            const exchange = this.exchange().finally(() => {
                if (this.inFlightExchange === exchange) {
                    this.inFlightExchange = null;
                }
            });
            this.inFlightExchange = exchange;
        }
        // Every caller, the one that started the exchange or one that joined it: the account changed while it was out,
        // so its answer is the old account's (or null): ask again as the new one.
        const token = await this.inFlightExchange;
        return generation === this.generation ? token : this.token();
    }

    /**
     * A dashboard window's session: the current exchanged token, how many seconds it has left, and whose it is. The
     * window renews by asking again (its page re-asks before the token runs out), so the machine's credential itself
     * never leaves this process. `fresh` exchanges anew even while the cached token looks good: the page asks for that
     * after the API refused it.
     *
     * null means no usable credential (never connected, or refused just now): the page shows its sign-in. A failure
     * to reach the API throws instead, so the page keeps what it has and asks again, as for any blip.
     */
    async session({ fresh = false } = {}) {
        if (!store.getCredential()) {
            return null;
        }
        if (fresh) {
            this.accessToken = null;
        }
        const token = await this.token();
        if (!token) {
            if (!store.getCredential()) {
                return null; // the exchange was refused: the credential is gone
            }
            throw new Error('LBCBot is not answering right now.');
        }
        return {
            accessToken: token,
            expiresIn: Math.max(60, Math.floor((this.tokenExpiresAt - Date.now()) / 1000)),
            userId: this.userId,
        };
    }

    /**
     * Trade a credential for a token at `POST /api/token`: `{ ok, token, expiresIn, userId }`, `{ refused: true }` when
     * LBCBot no longer takes it, or `{}` when it could not be reached.
     */
    async exchangeCredential(credential) {
        try {
            const response = await fetch(`${this.baseUrl()}/api/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: credential }),
            });
            if (!response.ok) {
                return response.status === 401 ? { refused: true } : {};
            }
            const body = await response.json();
            return { ok: true, token: body.accessToken, expiresIn: body.expiresIn || 3600, userId: body.userId };
        } catch (error) {
            this.onLog(`Token exchange failed: ${error.message}`);
            return {};
        }
    }

    /** The active account's exchange, cached by `token()`. */
    async exchange() {
        const id = store.activeAccountId();
        const credential = store.getCredential(id);
        if (!credential) {
            return null;
        }
        const generation = this.generation;
        const answer = await this.exchangeCredential(credential);
        if (generation !== this.generation) {
            return null; // switched meanwhile: token() asks again
        }
        if (answer.refused) {
            // Revoked or rotated in the dashboard. Forget it so the pane asks for a sign-in instead of hammering a
            // credential that can never work again. The account stays listed, signed out.
            this.onLog(`LBCBot no longer accepts ${this.accountName(id)} on this computer. Sign in to it again.`);
            store.signOutAccount(id, credential);
            return null;
        }
        if (!answer.ok) {
            return null;
        }
        this.accessToken = answer.token;
        this.tokenExpiresAt = Date.now() + answer.expiresIn * 1000;
        this.userId = answer.userId;
        if (answer.userId != null) {
            store.updateAccount(id, { userId: answer.userId }); // an account from before the list learns whose it is
        }
        return this.accessToken;
    }

    accountName(id) {
        const row = store.accounts().find((r) => r.id === id);
        return (row && row.username) || 'this account';
    }

    /**
     * Work as another listed account from now on: its credential, its token, its commands. The caller restarts device
     * control and reloads the dashboards. False for an id that names no account.
     */
    useAccount(id) {
        if (!store.setActiveAccount(id)) {
            return false;
        }
        this.resetSession();
        return true;
    }

    /** Drop everything that belonged to the account in use (after a switch, or when it is removed). */
    resetSession() {
        this.generation += 1;
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.userId = null;
        this.inFlightExchange = null;
        this.stopDeviceControl();
    }

    /** `signal` (optional) abandons the call — a caller that cannot wait long gives one. */
    async request(method, path, body, { retrying = false, signal, generation = this.generation } = {}) {
        const token = await this.token();
        if (generation !== this.generation) {
            // The account changed while this waited for its token, and token() follows a switch: the token it got is
            // the new account's. A call made as one account is never sent as another.
            return { ok: false, status: 0, error: 'account_changed' };
        }
        if (!token) {
            return { ok: false, status: 0, error: 'not_connected' };
        }
        try {
            const response = await fetch(`${this.baseUrl()}/api${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal,
            });
            if (response.status === 401 && !retrying) {
                if (generation !== this.generation) {
                    // Started as an account no longer in use: never send it again as another one.
                    return { ok: false, status: 401, error: 'account_changed' };
                }
                if (this.accessToken === token) {
                    this.accessToken = null;
                }
                return this.request(method, path, body, { retrying: true, signal, generation });
            }
            const text = await response.text();
            if (method === 'GET' && generation !== this.generation) {
                // Read as the account switched away from: its answer must not be drawn as the new account's. (A write
                // keeps its real outcome: it was done, as the account that asked.)
                return { ok: false, status: response.status, error: 'account_changed' };
            }
            if (!response.ok) {
                return { ok: false, status: response.status, error: text };
            }
            return { ok: true, data: text ? JSON.parse(text) : null };
        } catch (error) {
            return { ok: false, status: 0, error: error.message };
        }
    }

    // ------------------------------------------------------------------ device authorization: adding an account

    /**
     * Add an account: start the device flow, open the browser at the approval page, and wait (in the background) for
     * the approval. Answers as soon as the code is out — `{ ok: true, userCode, verificationUri, expiresIn }` — or `{ ok: false,
     * error }` when it could not start. One at a time: asking again while one waits answers the same code. `onDone`
     * gets the outcome once the flow ends: `{ ok: true, id, username }` (now listed and active), or `{ ok: false,
     * error }`.
     */
    startAddAccount({ onDone }) {
        // `starting` covers the code request itself, so a double click (or the pane and a dashboard menu together)
        // answers the same code rather than starting two flows.
        if (this.adding) {
            // The same code, with what is left of its time (not the full time again).
            const { expiresAt, ...pending } = this.adding;
            return Promise.resolve({ ...pending, expiresIn: Math.max(1, Math.round((expiresAt - Date.now()) / 1000)) });
        }
        if (!this.addStarting) {
            this.addStarting = this.beginAdd(onDone).finally(() => {
                this.addStarting = null;
            });
        }
        return this.addStarting;
    }

    async beginAdd(onDone) {
        const base = this.baseUrl();
        let grant;
        try {
            const start = await fetch(`${base}/api/device/code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientType: 'DESKTOP', name: 'Desktop app' }),
            });
            if (!start.ok) {
                return { ok: false, error: `Couldn't reach LBCBot (HTTP ${start.status}). Try again.` };
            }
            grant = await start.json();
        } catch (error) {
            return { ok: false, error: "Couldn't reach LBCBot. Try again." };
        }
        const expiresIn = grant.expiresIn || 600;
        const pending = { ok: true, userCode: grant.userCode, verificationUri: grant.verificationUri, expiresIn };
        this.adding = { ...pending, expiresAt: Date.now() + expiresIn * 1000 };
        const mine = this.adding;
        shell.openExternal(grant.verificationUriComplete);
        this.collect(grant)
            .catch((error) => ({ ok: false, error: `Adding the account failed: ${error.message}` }))
            .then((outcome) => {
                if (this.adding === mine) {
                    this.adding = null;
                }
                onDone(outcome);
            });
        return pending;
    }

    /** Poll for the approved credential, then list the account it signs in to. */
    async collect(grant) {
        const base = this.baseUrl();
        const intervalMs = Math.max(1, grant.interval || 5) * 1000;
        const deadline = Date.now() + (grant.expiresIn || 600) * 1000;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            let poll;
            let body = {};
            try {
                poll = await fetch(`${base}/api/device/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceCode: grant.deviceCode }),
                });
                body = await poll.json().catch(() => ({}));
            } catch (error) {
                continue; // a blip while the person decides: keep waiting
            }
            if (poll.ok && body.credential) {
                return this.listAccount(body.credential);
            }
            // authorization_pending is the expected answer while the user decides; anything else ends the flow.
            if (body.error && body.error !== 'authorization_pending') {
                return { ok: false, error: body.error === 'access_denied' ? 'The sign-in was declined.' : 'The code expired. Try again.' };
            }
        }
        return { ok: false, error: 'The code expired before it was approved. Try again.' };
    }

    /**
     * A freshly approved credential: whose it is (its exchange's user id; the name and platform from the
     * `/users/platforms` answer the pane reads anyway), then into the list as the active account. The same account
     * signed in again keeps its row, and its old credential is revoked. Past the cap, the new one is revoked again.
     */
    async listAccount(credential) {
        const answer = await this.exchangeCredential(credential);
        if (!answer.ok) {
            return { ok: false, error: "LBCBot didn't accept the new sign-in. Try again." };
        }
        const profile = { userId: answer.userId };
        const platforms = await this.call(answer.token, 'GET', '/users/platforms');
        if (platforms.ok && platforms.data) {
            profile.username = platforms.data.username;
            profile.platform = platforms.data.loginPlatform || platforms.data.mainPlatform;
        }
        const added = await store.addAccount(profile, credential);
        if (added.full) {
            this.revoke(credential, answer.token);
            return { ok: false, error: `Up to ${MAX_ACCOUNTS} accounts. Remove one to add another.` };
        }
        if (added.replaced) {
            this.revoke(added.replaced);
        }
        this.resetSession();
        // The token just exchanged is the active account's now: no second exchange.
        this.accessToken = answer.token;
        this.tokenExpiresAt = Date.now() + answer.expiresIn * 1000;
        this.userId = answer.userId;
        return { ok: true, id: added.id, username: profile.username || null };
    }

    /**
     * Revoke a device credential at LBCBot (best effort; true when it is revoked). The API revokes by credential id, which
     * this app never learned, so it is found in the account's own list by its prefix (the first 12 characters, all the
     * list shows): two calls with that credential's token, and a third to exchange when none is given.
     */
    async revoke(credential, token = null) {
        if (!credential) {
            return false;
        }
        let bearer = token;
        if (!bearer) {
            const answer = await this.exchangeCredential(credential);
            if (answer.refused) {
                return true; // already refused: revoked, or idle past use
            }
            bearer = answer.ok ? answer.token : null;
        }
        if (!bearer) {
            return false;
        }
        const list = await this.call(bearer, 'GET', '/users/credentials');
        if (!list.ok || !Array.isArray(list.data)) {
            return false;
        }
        const prefix = credential.slice(0, 12);
        const matches = list.data.filter((c) => c.tokenPrefix === prefix && !c.revokedAt);
        if (matches.length !== 1) {
            return false; // none, or two that share a prefix: never revoke a guess
        }
        const done = await this.call(bearer, 'DELETE', `/users/credentials/${encodeURIComponent(matches[0].credentialId)}`);
        return done.ok;
    }

    /** One call with a given token (not the active account's): `{ ok, status, data }`. */
    async call(token, method, path) {
        try {
            const response = await fetch(`${this.baseUrl()}/api${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            });
            const text = await response.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }
            return { ok: response.ok, status: response.status, data };
        } catch (error) {
            return { ok: false, status: 0, data: null };
        }
    }

    /**
     * Remove an account from this computer: revoke its credential at LBCBot (best effort), then forget it here. Answers
     * `{ revoked, wasActive }`; when it was the account in use, the next one listed is active now (or none).
     */
    async removeAccount(id) {
        const credential = store.getCredential(id);
        const token = store.activeAccountId() === id && this.accessToken && Date.now() < this.tokenExpiresAt ? this.accessToken : null;
        const revoked = credential ? await this.revoke(credential, token) : true;
        // Read after the revoke: the account may have been switched to while it was out.
        const wasActive = store.activeAccountId() === id;
        store.removeAccount(id);
        if (wasActive) {
            this.resetSession();
        }
        return { revoked, wasActive };
    }

    // ------------------------------------------------------------------ device commands in (STOMP)

    /**
     * Subscribe to `/topic/deviceControl/{userId}` to receive the OBS and GreenSplit actions attached to triggers.
     * Each command's `target` says which (none means OBS); index.js routes them.
     *
     * STOMP over a plain WebSocket — kafka-ws-proxy's /ws/lbcbot/websocket, the endpoint the web app uses too —
     * through Node's built-in WebSocket (Electron 43 bundles Node 24, which has one). It replaced sockjs-client, the
     * proxy's last SockJS client. @stomp/stompjs asks for the v1x.stomp subprotocols; the proxy selects one, without
     * which Node's WebSocket (like a browser) refuses the handshake.
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

        const { Client } = require('@stomp/stompjs');

        const client = new Client({
            brokerURL: `${this.baseUrl().replace(/\/+$/, '').replace(/^http/, 'ws')}/ws/lbcbot/websocket`,
            connectHeaders: { Authorization: `Bearer ${token}` },
            // Match the proxy's 10s/10s heartbeats, so a silently dead connection surfaces in seconds rather than
            // looking subscribed forever. Main-process timers are Node's, not throttled like a hidden window's.
            heartbeatIncoming: 10000,
            heartbeatOutgoing: 10000,
            // A missed heartbeat drops the socket at once rather than waiting on a close a dead peer never answers.
            discardWebsocketOnCommFailure: true,
            reconnectDelay: 5000,
            debug: () => {},
        });

        client.onConnect = () => {
            this.onLog('Listening for OBS and GreenSplit commands from LBCBot.');
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

    /** One GreenSplit trigger — the body is built by greensplit.js's mapping, one trigger type per post. */
    postGreenSplitEvent(payload, { signal } = {}) {
        return this.request('POST', '/users/greensplit/event', payload, { signal });
    }

    /**
     * Tell LBCBot an integration is set up on this machine (`greensplit`), so the website offers its triggers and
     * actions only to people who can fire them. Sent on every GreenSplit hello; the server keeps the first-seen time.
     */
    putIntegration(integration, body) {
        return this.request('PUT', `/users/integrations/${encodeURIComponent(integration)}`, body);
    }

    /** The user turned the integration off here: the website stops offering it. */
    deleteIntegration(integration) {
        return this.request('DELETE', `/users/integrations/${encodeURIComponent(integration)}`);
    }
}

module.exports = { LbcBot };
