// Pure parsers and formatters for /proc, /sys and nvidia-smi text.
// No I/O lives here, so everything can be unit-tested with plain gjs.

export function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

// First line of /proc/stat: "cpu user nice system idle iowait irq softirq steal guest guest_nice".
// guest/guest_nice are already included in user/nice, so only the first 8 fields count.
export function parseCpuStat(text) {
    const f = text.split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
    const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
    return {idle: f[3] + f[4], total};
}

export function cpuPercent(prev, cur) {
    if (!prev)
        return null;
    const dt = cur.total - prev.total;
    if (dt <= 0)
        return null;
    return clamp(100 * (dt - (cur.idle - prev.idle)) / dt, 0, 100);
}

// Average "cpu MHz" across cores in /proc/cpuinfo.
export function parseCpuMhz(text) {
    const mhz = [...text.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map(m => Number(m[1]));
    if (!mhz.length)
        return null;
    return mhz.reduce((a, b) => a + b, 0) / mhz.length;
}

export function parseMeminfo(text) {
    const kb = key => {
        const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
        return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    if (total === null || available === null)
        return null;
    return {total, used: total - available};
}

const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|vnet|tun|tap|wg)/;

// Total rx/tx bytes over physical interfaces in /proc/net/dev.
export function parseNetDev(text) {
    let rx = 0, tx = 0;
    for (const line of text.split('\n').slice(2)) {
        const [name, rest] = line.split(':');
        if (!rest || VIRTUAL_IFACE.test(name.trim()))
            continue;
        const f = rest.trim().split(/\s+/).map(Number);
        rx += f[0];
        tx += f[8];
    }
    return {rx, tx};
}

const WHOLE_DISK = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+)$/;

// Total read/write bytes over whole disks (not partitions) in /proc/diskstats.
export function parseDiskstats(text) {
    let read = 0, write = 0;
    for (const line of text.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || !WHOLE_DISK.test(f[2]))
            continue;
        read += Number(f[5]) * 512;
        write += Number(f[9]) * 512;
    }
    return {read, write};
}

export function rate(prev, cur, seconds) {
    if (prev === null || prev === undefined || seconds <= 0 || cur < prev)
        return null;
    return (cur - prev) / seconds;
}

// Output of: nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total
//            --format=csv,noheader,nounits
export function parseNvidiaSmi(text) {
    const f = text.split('\n', 1)[0].split(',').map(s => Number(s.trim()));
    if (f.length < 4 || f.some(Number.isNaN))
        return null;
    const MiB = 1024 * 1024;
    return {util: f[0], temp: f[1], memUsed: f[2] * MiB, memTotal: f[3] * MiB};
}

export function formatSize(bytes) {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes < 10 && i > 0 ? bytes.toFixed(1) : Math.round(bytes)}${units[i]}`;
}

export function formatRate(bytesPerSec) {
    if (bytesPerSec === null)
        return '–';
    return `${formatSize(bytesPerSec)}/s`;
}

export function formatTemp(celsius, unit) {
    if (celsius === null || celsius === undefined)
        return '–';
    const v = unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
    return `${Math.round(v)}°`;
}

export function formatPercent(v) {
    if (v === null || v === undefined)
        return '–';
    return `${Math.round(v)}%`.padStart(4);
}

// 'ok' | 'warn' | 'hot' for colouring a value against two thresholds.
export function level(value, warn, crit) {
    if (value === null || value === undefined || value < warn)
        return 'ok';
    return value < crit ? 'warn' : 'hot';
}
