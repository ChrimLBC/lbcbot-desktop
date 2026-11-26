'use strict';

const net = require('node:net');
const os = require('node:os');
const dns = require('node:dns');
const { execFile } = require('node:child_process');

/**
 * "Find OBS on my network": which computers on this LAN have obs-websocket listening.
 *
 * OBS does not announce itself (no mDNS), so this sweeps the local subnet for its port, then confirms each answer is
 * really obs-websocket by reading its Hello. It runs only when someone clicks Find: a /24 takes about a second at 64
 * probes at a time, and nothing here leaves the local network.
 *
 * Only private IPv4 ranges are swept, and never more than the 254 hosts of a /24 per adapter, so a VPN or a /16
 * office network can't turn one click into 65,000 connections.
 */

const OBS_PORT = 4455;
const PROBE_TIMEOUT_MS = 300;
const HELLO_TIMEOUT_MS = 1500;
const NAME_TIMEOUT_MS = 800;
const CONCURRENCY = 128;
/**
 * Adapters that never lead to another PC: WSL and Hyper-V switches, VM and container bridges, VPN tunnels. On a
 * Windows PC with WSL these alone tripled a scan (2 x 254 more hosts that never answer).
 */
const VIRTUAL_ADAPTER = /^(vEthernet|VirtualBox|VMware|Hyper-V|docker|br-|veth|virbr|vboxnet|utun|tun|tap|wg|tailscale|ZeroTier|Bluetooth)/i;

function ipToInt(ip) {
    return ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
}

function intToIp(n) {
    return [24, 16, 8, 0].map((shift) => Math.floor(n / (2 ** shift)) % 256).join('.');
}

function isPrivate(ip) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The hosts to probe, from `os.networkInterfaces()`'s shape: each private IPv4 adapter's subnet, narrowed to its /24
 * when the subnet is wider. This PC's own addresses are included (OBS here listens on them too) and marked local.
 */
function scanTargets(interfaces) {
    const hosts = new Map(); // ip -> { local }
    Object.entries(interfaces || {})
        .filter(([name]) => !VIRTUAL_ADAPTER.test(name))
        .flatMap(([, addrs]) => addrs || [])
        .forEach((addr) => {
        if (!addr || addr.internal || (addr.family !== 'IPv4' && addr.family !== 4) || !isPrivate(addr.address)) {
            return;
        }
        let prefix = Number(String(addr.cidr || '').split('/')[1]);
        if (!Number.isInteger(prefix)) {
            prefix = addr.netmask ? addr.netmask.split('.').reduce((n, o) => n + (Number(o).toString(2).match(/1/g) || []).length, 0) : 24;
        }
        prefix = Math.min(Math.max(prefix, 24), 30);
        const size = 2 ** (32 - prefix);
        const base = Math.floor(ipToInt(addr.address) / size) * size;
        for (let i = 1; i < size - 1; i += 1) {
            const ip = intToIp(base + i);
            if (!hosts.has(ip)) hosts.set(ip, { local: false });
        }
        hosts.set(addr.address, { local: true });
        });
    return hosts;
}

/** Whether something accepts a TCP connection on host:port within the timeout. */
function probe(host, port, timeoutMs, connectTcp = net.connect) {
    return new Promise((resolve) => {
        const socket = connectTcp({ host, port });
        const done = (open) => {
            socket.removeAllListeners();
            socket.on('error', () => {});
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/**
 * Open the WebSocket and read obs-websocket's Hello (op 0). Answers its version and whether it wants a password, or
 * null when whatever is on that port isn't obs-websocket.
 */
function readHello(url, timeoutMs, WebSocketImpl = globalThis.WebSocket) {
    return new Promise((resolve) => {
        let ws;
        try {
            ws = new WebSocketImpl(url, 'obswebsocket.json');
        } catch (error) {
            resolve(null);
            return;
        }
        const finish = (result) => {
            clearTimeout(timer);
            try { ws.close(); } catch (error) { /* already closed */ }
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
                if (message && message.op === 0 && message.d) {
                    finish({ version: message.d.obsWebSocketVersion || '', authRequired: Boolean(message.d.authentication) });
                    return;
                }
            } catch (error) {
                // Not JSON: not obs-websocket.
            }
            finish(null);
        };
        ws.onerror = () => finish(null);
        ws.onclose = () => finish(null);
    });
}

/** Run `task` over `items`, at most `limit` at once. */
async function pool(items, limit, task) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await task(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** The NetBIOS name `nbtstat -A` prints for an address: the `<00> UNIQUE` row. Windows only. */
function parseNbtstat(output) {
    const match = /^\s*([^\s<]+)\s*<00>\s+UNIQUE/m.exec(String(output || ''));
    return match ? match[1] : null;
}

/**
 * A computer name for an address: reverse DNS (many home routers answer it) or NetBIOS on Windows, asked together.
 * Plenty of networks answer neither (2026-11-26: this house's router and Windows 11 both stay silent), and then the
 * list shows the address.
 */
async function hostName(ip) {
    const viaDns = dns.promises.reverse(ip)
        .then((names) => (names && names[0] ? names[0].replace(/\.(lan|local|home|localdomain)$/i, '') : null))
        .catch(() => null);
    const viaNetbios = process.platform !== 'win32' ? Promise.resolve(null) : new Promise((resolve) => {
        execFile('nbtstat', ['-A', ip], { windowsHide: true, timeout: NAME_TIMEOUT_MS }, (error, stdout) => {
            resolve(error ? null : parseNbtstat(stdout));
        });
    });
    const [a, b] = await Promise.all([withTimeout(viaDns, NAME_TIMEOUT_MS), withTimeout(viaNetbios, NAME_TIMEOUT_MS + 200)]);
    return a || b || null;
}

/**
 * Find every obs-websocket on this LAN. Each result: `{ host, url, name, local, version, authRequired }`, this PC first,
 * then by address.
 */
async function discover({
    port = OBS_PORT,
    interfaces = os.networkInterfaces(),
    probeFn = (host) => probe(host, port, PROBE_TIMEOUT_MS),
    helloFn = (url) => readHello(url, HELLO_TIMEOUT_MS),
    nameFn = hostName,
    localName = os.hostname(),
} = {}) {
    const targets = scanTargets(interfaces);
    const ips = [...targets.keys()];
    const open = await pool(ips, CONCURRENCY, probeFn);
    const hits = ips.filter((ip, i) => open[i]);

    const found = await Promise.all(hits.map(async (host) => {
        const url = `ws://${host}:${port}`;
        const hello = await helloFn(url);
        if (!hello) {
            return null;
        }
        const local = targets.get(host).local;
        const name = local ? localName : await nameFn(host);
        return { host, url, name: name || null, local, version: hello.version, authRequired: hello.authRequired };
    }));
    const sorted = found
        .filter(Boolean)
        .sort((a, b) => (Number(b.local) - Number(a.local)) || (ipToInt(a.host) - ipToInt(b.host)));
    // This PC answers on each of its adapters (Wi-Fi, Ethernet, WSL): list it once.
    return sorted.filter((row, i) => !row.local || sorted.findIndex((r) => r.local) === i);
}

module.exports = { discover, scanTargets, probe, readHello, parseNbtstat, isPrivate, OBS_PORT };
