// Run with: gjs -m tests/parse.test.js
import * as P from '../lib/parse.js';
import System from 'system';

let failed = 0;
function eq(actual, expected, name) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) {
        print(`ok   ${name}`);
    } else {
        print(`FAIL ${name}\n     expected ${e}\n     got      ${a}`);
        failed++;
    }
}

const stat1 = 'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n';
const stat2 = 'cpu  200 0 200 1400 200 0 0 0 50 0\ncpu0 1 2 3 4\n';
eq(P.parseCpuStat(stat1), {idle: 800, total: 1000}, 'parseCpuStat sums first 8 fields');
eq(P.cpuPercent(P.parseCpuStat(stat1), P.parseCpuStat(stat2)), 20, 'cpuPercent ignores guest time');
eq(P.cpuPercent(null, P.parseCpuStat(stat2)), null, 'cpuPercent needs a previous sample');

eq(P.parseCpuMhz('cpu MHz\t\t: 1000.000\nfoo\ncpu MHz\t\t: 3000.500\n'), 2000.25, 'parseCpuMhz averages cores');
eq(P.parseCpuMhz('nothing here'), null, 'parseCpuMhz missing');

eq(P.parseMeminfo('MemTotal:       16000 kB\nMemFree:  1 kB\nMemAvailable:   10000 kB\n'),
    {total: 16000 * 1024, used: 6000 * 1024}, 'parseMeminfo uses MemAvailable');

const netdev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  999999     10    0    0    0     0          0         0   999999     10    0    0    0     0       0          0
wlp0s20f3: 5000     10    0    0    0     0          0         0     700      10    0    0    0     0       0          0
docker0:  888     10    0    0    0     0          0         0     888      10    0    0    0     0       0          0
enp3s0: 1000     10    0    0    0     0          0         0     300      10    0    0    0     0       0          0
`;
eq(P.parseNetDev(netdev), {rx: 6000, tx: 1000}, 'parseNetDev skips lo and virtual');

const diskstats = `
 259       0 nvme0n1 100 0 2000 0 50 0 4000 0 0 0 0
 259       1 nvme0n1p1 100 0 2000 0 50 0 4000 0 0 0 0
   7       0 loop0 1 0 99 0 0 0 0 0 0 0 0
   8       0 sda 1 0 10 0 1 0 20 0 0 0 0
`;
eq(P.parseDiskstats(diskstats), {read: 2010 * 512, write: 4020 * 512}, 'parseDiskstats whole disks only');

eq(P.rate(100, 400, 1.5), 200, 'rate');
eq(P.rate(null, 400, 1.5), null, 'rate without previous');
eq(P.rate(500, 400, 1.5), null, 'rate on counter reset');

eq(P.parseNvidiaSmi('28, 46, 270, 4096\n'),
    {util: 28, temp: 46, memUsed: 270 * 1048576, memTotal: 4096 * 1048576}, 'parseNvidiaSmi');
eq(P.parseNvidiaSmi('[N/A], 46, 270, 4096'), null, 'parseNvidiaSmi rejects N/A');

eq(P.formatSize(6.1 * 1024 ** 3), '6.1G', 'formatSize small G');
eq(P.formatSize(16 * 1024 ** 3), '16G', 'formatSize big G');
eq(P.formatSize(512), '512B', 'formatSize bytes');
eq(P.formatRate(2.4 * 1024 ** 2), '2.4M/s', 'formatRate');
eq(P.formatTemp(71.4, 'C'), '71°', 'formatTemp C');
eq(P.formatTemp(100, 'F'), '212°', 'formatTemp F');
eq(P.formatTemp(null, 'C'), '–', 'formatTemp missing');
eq(P.formatPercent(8), '  8%', 'formatPercent pads to fixed width');
eq(P.level(60, 70, 85), 'ok', 'level ok');
eq(P.level(70, 70, 85), 'warn', 'level warn');
eq(P.level(90, 70, 85), 'hot', 'level hot');
eq(P.level(null, 70, 85), 'ok', 'level missing');

print(failed ? `\n${failed} failed` : '\nall passed');
System.exit(failed ? 1 : 0);
