// Smoke test against this machine's real sensors.
// Run with: gjs -m tests/sensors.live.js
import GLib from 'gi://GLib';
import {Sensors} from '../lib/sensors.js';

const loop = new GLib.MainLoop(null, false);
const s = new Sensors();
(async () => {
    try {
        await s.discover();
        print(`gpu: ${s.gpu?.kind ?? 'none'}`);
        await s.sample();
        await new Promise(r => setTimeout(r, 1000));
        print(JSON.stringify(await s.sample(), null, 2));
    } catch (e) {
        logError(e);
    } finally {
        loop.quit();
    }
})();
loop.run();
