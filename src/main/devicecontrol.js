'use strict';

/**
 * Where a command from `/topic/deviceControl/{userId}` goes.
 *
 * The API publishes OBS and GreenSplit actions on the same topic. A GreenSplit one says `target: "greensplit"`; an OBS
 * one has no target at all — its shape predates there being a second device — so a missing target means OBS, and
 * always will. A target this version does not know is logged and dropped rather than handed to OBS to misread.
 *
 * Kept out of index.js (which needs Electron) so the routing runs under `node --test`.
 */
function routeDeviceCommand(command, { obs, greensplit, onLog = () => {} }) {
    const target = command && command.target;
    if (!target || target === 'obs') {
        return obs.execute(command);
    }
    if (target === 'greensplit') {
        return greensplit.execute(command);
    }
    onLog(`Ignored a command for "${target}" — this version of the app does not know it. Update the app.`);
    return undefined;
}

module.exports = { routeDeviceCommand };
