'use strict';

/**
 * The streamer's Twitch chat pop-out stays theirs when a raid goes.
 *
 * <h3>What happens without this</h3>
 *
 * When a raid goes, from Raid Now or at the end of the countdown, Twitch's raid banner FOLLOWS it: any chat page sends
 * itself to the raided channel's chat, `location.assign('https://www.twitch.tv/<target>/chat?referrer=raid')` (read in
 * Twitch's chat bundle, 2026-11-08). Dashboards keep the streamer's chat pop-out in two places, and neither should go:
 * <ul>
 *   <li>The Twitch Actions card keeps it loaded out of sight to relay Raid Now (raidNowRelay in LBCBot-frontend). Moved,
 *       it found no banner for any later raid, so Raid Now only ever lit for the first raid after the dashboard
 *       opened.</li>
 *   <li>The Twitch Backstage card's "My Chat" view shows it. Moved, the streamer's own chat turned into another
 *       channel's for the rest of the session.</li>
 * </ul>
 *
 * <h3>Why here</h3>
 *
 * The dashboard page can watch a webview's `will-navigate`, but cannot cancel it: all it can do is stop the page, which
 * also cancels whatever it was fetching, and reload it. That is fine for the hidden relay, which does exactly that as a
 * fallback (watchWebview's `stayOn` in LBCBot-frontend: it still runs, on a move already refused here, and reloads a
 * page nobody sees). It is not fine for a chat the streamer is looking at and typing in. Here the move is refused before
 * it starts and the page carries on as it was, so My Chat needs nothing from the dashboard at all. Twitch's raid code
 * has expired the banner before the move, so nothing of the raid stays behind.
 *
 * <h3>What is refused</h3>
 *
 * Only a move from the streamer's chat pop-out to ANOTHER CHANNEL'S chat: the raid follow and nothing else. Sign-in, and
 * every other page, still navigate as they always did.
 */

/**
 * The streamer's own chat pop-out, also in the `/popout/u/<login>/…` form Twitch gives its other dashboard pages. The
 * same test as isOwnChat in LBCBot-frontend's raidNowRelay.js.
 */
function isOwnChat(url) {
    try {
        const u = new URL(url);
        return u.hostname === 'dashboard.twitch.tv' && /^\/popout(?:\/u\/[^/]+)?\/stream-manager\/chat\/?$/.test(u.pathname);
    } catch {
        return false;
    }
}

/** Hosts that serve a channel's chat page. Not clips, not the dashboard (the streamer's own pop-out is there). */
const CHAT_HOSTS = new Set(['www.twitch.tv', 'twitch.tv', 'm.twitch.tv']);

/** Some channel's chat page on Twitch: `/<login>/chat`, or its pop-out and embed forms. */
function isChannelChat(url) {
    try {
        const u = new URL(url);
        return CHAT_HOSTS.has(u.hostname) && /^\/(?:popout\/|embed\/)?[^/]+\/chat\/?$/.test(u.pathname);
    } catch {
        return false;
    }
}

/** Would this move take the streamer's chat pop-out to another channel's chat? (Their hosts never overlap.) */
function followsRaid(from, to) {
    return isOwnChat(from) && isChannelChat(to);
}

/**
 * Refuse the raid follow in one webContents; the app gives every one it creates this guard. `will-navigate` is the
 * main frame's, and only for moves the page itself starts. Each refusal is logged (a raid going makes one or two), so a
 * click that seemed to do nothing can be traced.
 */
function keepChatOnRaid(contents, log = () => {}) {
    contents.on('will-navigate', (event, legacyUrl) => {
        const to = (event && event.url) || legacyUrl;
        if (followsRaid(contents.getURL(), to)) {
            event.preventDefault();
            log(`Kept the Twitch chat on your channel: refused its move to ${to.split('?')[0]} (a raid going)`);
        }
    });
}

module.exports = { keepChatOnRaid, followsRaid };
