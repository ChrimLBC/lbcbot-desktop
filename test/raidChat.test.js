'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { keepChatOnRaid, followsRaid } = require('../src/main/raidChat');

const OWN = 'https://dashboard.twitch.tv/popout/stream-manager/chat';
const RAID = 'https://www.twitch.tv/coolstreamer/chat?referrer=raid';

test('the raid follow out of the streamer\'s chat pop-out is refused', () => {
    assert.equal(followsRaid(OWN, RAID), true);
    assert.equal(followsRaid(`${OWN}?darkpopout`, 'https://twitch.tv/coolstreamer/chat'), true);
    assert.equal(followsRaid(OWN, 'https://m.twitch.tv/coolstreamer/chat'), true);
    assert.equal(followsRaid('https://dashboard.twitch.tv/popout/u/chrislbc/stream-manager/chat', RAID), true);
    assert.equal(followsRaid(OWN, 'https://www.twitch.tv/popout/coolstreamer/chat?popout='), true);
    assert.equal(followsRaid(OWN, 'https://www.twitch.tv/embed/coolstreamer/chat?parent=x'), true);
});

test('every other move is left alone', () => {
    // Not from the chat pop-out: Stream Manager, Activity Feed, a channel page.
    assert.equal(followsRaid('https://dashboard.twitch.tv/u/chrislbc/stream-manager', RAID), false);
    assert.equal(followsRaid('https://dashboard.twitch.tv/popout/stream-manager/activity-feed', RAID), false);
    assert.equal(followsRaid('https://www.twitch.tv/somebody/chat', RAID), false);
    // From it, but not to another channel's chat: sign-in, the same pop-out in its other form, a channel page.
    assert.equal(followsRaid(OWN, 'https://www.twitch.tv/login'), false);
    assert.equal(followsRaid(OWN, 'https://id.twitch.tv/oauth2/authorize?x=1'), false);
    assert.equal(followsRaid(OWN, 'https://dashboard.twitch.tv/popout/u/chrislbc/stream-manager/chat'), false);
    assert.equal(followsRaid(OWN, `${OWN}?refresh=1`), false);
    assert.equal(followsRaid(OWN, 'https://www.twitch.tv/coolstreamer'), false);
    // Not Twitch at all, and nonsense.
    assert.equal(followsRaid(OWN, 'https://evil.example/coolstreamer/chat'), false);
    assert.equal(followsRaid(OWN, 'https://nottwitch.tv/coolstreamer/chat'), false);
    // Twitch hosts that never serve a channel's chat.
    assert.equal(followsRaid(OWN, 'https://clips.twitch.tv/coolclip/chat'), false);
    assert.equal(followsRaid(OWN, 'https://dashboard.twitch.tv/coolstreamer/chat'), false);
    assert.equal(followsRaid('not a url', RAID), false);
    assert.equal(followsRaid(OWN, undefined), false);
});

/** A webContents with a current address, whose will-navigate this test can fire. */
function contentsAt(url) {
    const contents = new EventEmitter();
    contents.getURL = () => url;
    return contents;
}

/** Fire will-navigate the way Electron 45 does: an event carrying the url, then the deprecated positional url. */
function navigate(contents, to) {
    let prevented = false;
    contents.emit('will-navigate', { url: to, preventDefault: () => { prevented = true; } }, to);
    return prevented;
}

test('keepChatOnRaid prevents the follow and nothing else, and logs what it refused', () => {
    const lines = [];
    const chat = contentsAt(OWN);
    keepChatOnRaid(chat, (line) => lines.push(line));
    assert.equal(navigate(chat, RAID), true);
    assert.equal(navigate(chat, 'https://www.twitch.tv/login'), false);
    assert.deepEqual(lines, ['Kept the Twitch chat on your channel: refused its move to https://www.twitch.tv/coolstreamer/chat (a raid going)']);

    const manager = contentsAt('https://dashboard.twitch.tv/u/chrislbc/stream-manager');
    keepChatOnRaid(manager);
    assert.equal(navigate(manager, RAID), false);
});

test('an older Electron that passes only the positional url is covered too', () => {
    const chat = contentsAt(OWN);
    keepChatOnRaid(chat);
    let prevented = false;
    chat.emit('will-navigate', { preventDefault: () => { prevented = true; } }, RAID);
    assert.equal(prevented, true);
});
