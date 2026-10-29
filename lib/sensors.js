// Reads system stats from /proc, /sys and nvidia-smi.
// Every read is async: some hwmon drivers (e.g. dell_smm) take milliseconds to
// answer, and a blocking read here would stall the whole shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as P from './parse.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const decoder = new TextDecoder();

// Preferred CPU temperature drivers, best first, with the label of the "whole CPU" sensor.
const CPU_TEMP_DRIVERS = [
    ['coretemp', /^Package/],
    ['k10temp', /^T(ctl|die)/],
    ['zenpower', /^T(ctl|die)/],
    ['cpu_thermal', null],
    ['acpitz', null],
];
const DISK_TEMP_DRIVERS = ['nvme', 'drivetemp'];

async function readText(path, cancellable = null) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return decoder.decode(bytes);
}

async function tryReadText(path, cancellable = null) {
    try {
        return (await readText(path, cancellable)).trim();
    } catch (e) {
        return null;
    }
}

async function tryReadInt(path, cancellable = null) {
    const text = await tryReadText(path, cancellable);
    const n = parseInt(text);
    return Number.isNaN(n) ? null : n;
}

async function listDir(path) {
    try {
        const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        const names = [];
        for (;;) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
            if (!infos.length)
                break;
            names.push(...infos.map(i => i.get_name()));
        }
        return names.sort();
    } catch (e) {
        return [];
    }
}

// One hwmon device: its driver name and its inputs, e.g. {temp1: {label}, fan1: {label}}.
async function readHwmon(dir) {
    const files = await listDir(dir);
    const inputs = {};
    for (const f of files) {
        const m = f.match(/^((temp|fan)\d+)_input$/);
        if (m)
            inputs[m[1]] = {path: `${dir}/${f}`, label: await tryReadText(`${dir}/${m[1]}_label`)};
    }
    return {dir, name: await tryReadText(`${dir}/name`), inputs};
}

function pickInput(hwmon, kind, labelRe) {
    const entries = Object.entries(hwmon.inputs).filter(([id]) => id.startsWith(kind));
    if (!entries.length)
        return null;
    const match = labelRe && entries.find(([, i]) => labelRe.test(i.label ?? ''));
    return (match ?? entries[0])[1].path;
}

// A discrete GPU we can poll. Reading most of its sysfs files, or running
// nvidia-smi, wakes it from runtime suspend, so we check power state first.
class Gpu {
    constructor(kind, devDir, hwmon) {
        this.kind = kind;
        this.devDir = devDir;
        this.tempPath = hwmon ? pickInput(hwmon, 'temp', /^edge/) : null;
        this._running = false;
    }

    async read(cancellable) {
        const power = await tryReadText(`${this.devDir}/power/runtime_status`, cancellable);
        if (power === 'suspended')
            return {sleeping: true};
        return this.kind === 'nvidia' ? this._readNvidia(cancellable) : this._readAmd(cancellable);
    }

    async _readNvidia(cancellable) {
        if (this._running)
            return this._last ?? null;
        this._running = true;
        try {
            const proc = Gio.Subprocess.new(
                ['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
                    '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const [stdout] = await proc.communicate_utf8_async(null, cancellable);
            this._last = proc.get_successful() ? P.parseNvidiaSmi(stdout) : null;
        } catch (e) {
            this._last = null;
        } finally {
            this._running = false;
        }
        return this._last;
    }

    async _readAmd(cancellable) {
        const [util, temp, memUsed, memTotal] = await Promise.all([
            tryReadInt(`${this.devDir}/gpu_busy_percent`, cancellable),
            this.tempPath ? tryReadInt(this.tempPath, cancellable) : null,
            tryReadInt(`${this.devDir}/mem_info_vram_used`, cancellable),
            tryReadInt(`${this.devDir}/mem_info_vram_total`, cancellable),
        ]);
        if (util === null)
            return null;
        return {util, temp: temp === null ? null : temp / 1000, memUsed, memTotal};
    }
}

async function findGpu(hwmons) {
    if (GLib.find_program_in_path('nvidia-smi')) {
        const addr = (await listDir('/sys/bus/pci/drivers/nvidia')).find(n => /^[\da-f]{4}:/.test(n));
        if (addr)
            return new Gpu('nvidia', `/sys/bus/pci/devices/${addr}`, null);
    }
    for (const card of await listDir('/sys/class/drm')) {
        if (!/^card\d+$/.test(card))
            continue;
        const devDir = `/sys/class/drm/${card}/device`;
        if (await tryReadText(`${devDir}/gpu_busy_percent`) === null)
            continue;
        const real = GLib.canonicalize_filename(devDir, null);
        const hwmon = hwmons.find(h => h.name === 'amdgpu' &&
            GLib.canonicalize_filename(`${h.dir}/device`, null) === real);
        return new Gpu('amd', devDir, hwmon);
    }
    return null;
}

export class Sensors {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._prev = null;
    }

    async discover() {
        const hwmons = [];
        for (const n of await listDir('/sys/class/hwmon'))
            hwmons.push(await readHwmon(`/sys/class/hwmon/${n}`));

        this._cpuTemp = null;
        for (const [driver, labelRe] of CPU_TEMP_DRIVERS) {
            const h = hwmons.find(x => x.name === driver);
            if (h && (this._cpuTemp = pickInput(h, 'temp', labelRe)))
                break;
        }

        const disk = hwmons.find(h => DISK_TEMP_DRIVERS.includes(h.name));
        this._diskTemp = disk ? pickInput(disk, 'temp', /^Composite/) : null;

        // Several drivers can expose the same fans (dell_smm + alienware_wmi);
        // use a single source, preferring one that labels its fans.
        const fanSources = hwmons.filter(h => Object.keys(h.inputs).some(k => k.startsWith('fan')));
        const fanSource = fanSources.find(h =>
            Object.entries(h.inputs).some(([k, i]) => k.startsWith('fan') && i.label)) ?? fanSources[0];
        this._fans = fanSource
            ? Object.entries(fanSource.inputs)
                .filter(([k]) => k.startsWith('fan'))
                .map(([k, i]) => ({path: i.path, label: i.label ?? `Fan ${k.slice(3)}`}))
            : [];

        this._battery = (await listDir('/sys/class/power_supply'))
            .filter(n => /^BAT/.test(n)).map(n => `/sys/class/power_supply/${n}`)[0] ?? null;

        this.gpu = await findGpu(hwmons);
    }

    // Returns a snapshot; rate-based fields are null on the first call.
    async sample() {
        const c = this._cancellable;
        const now = GLib.get_monotonic_time() / 1e6;
        const [stat, cpuinfo, meminfo, netdev, diskstats, cpuTemp, diskTemp, fans, battery, gpu] =
            await Promise.all([
                readText('/proc/stat', c),
                readText('/proc/cpuinfo', c),
                readText('/proc/meminfo', c),
                readText('/proc/net/dev', c),
                readText('/proc/diskstats', c),
                this._cpuTemp ? tryReadInt(this._cpuTemp, c) : null,
                this._diskTemp ? tryReadInt(this._diskTemp, c) : null,
                Promise.all(this._fans.map(async f => ({label: f.label, rpm: await tryReadInt(f.path, c)}))),
                this._readBattery(c),
                this.gpu ? this.gpu.read(c) : null,
            ]);

        const cur = {
            time: now,
            cpu: P.parseCpuStat(stat),
            net: P.parseNetDev(netdev),
            disk: P.parseDiskstats(diskstats),
        };
        const prev = this._prev;
        const dt = prev ? cur.time - prev.time : 0;
        this._prev = cur;

        return {
            cpu: {
                percent: P.cpuPercent(prev?.cpu, cur.cpu),
                mhz: P.parseCpuMhz(cpuinfo),
                temp: cpuTemp === null ? null : cpuTemp / 1000,
            },
            mem: P.parseMeminfo(meminfo),
            gpu,
            disk: {
                temp: diskTemp === null ? null : diskTemp / 1000,
                read: P.rate(prev?.disk.read, cur.disk.read, dt),
                write: P.rate(prev?.disk.write, cur.disk.write, dt),
            },
            net: {
                down: P.rate(prev?.net.rx, cur.net.rx, dt),
                up: P.rate(prev?.net.tx, cur.net.tx, dt),
            },
            fans: fans.filter(f => f.rpm !== null),
            battery,
        };
    }

    async _readBattery(c) {
        if (!this._battery)
            return null;
        const [capacity, status] = await Promise.all([
            tryReadInt(`${this._battery}/capacity`, c),
            tryReadText(`${this._battery}/status`, c),
        ]);
        return capacity === null ? null : {capacity, status};
    }

    destroy() {
        this._cancellable.cancel();
    }
}
