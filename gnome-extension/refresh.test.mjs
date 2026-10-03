import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {commandFailure, errorLine, parseReport, reportOutdated} from './report-model.js';

// Run the production scheduling and subprocess callbacks, with a controllable
// clock/process boundary. No Shell session, real binary or account is needed.
const source = readFileSync(new URL('./extension.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const methods = ['_run', '_refreshReport', '_restartReportTimer', '_reportArrived',
    '_reportFailed', '_setBusy', '_tick', '_reproject'];
const implementations = methods.map(name => {
    const match = source.match(new RegExp(`\\n {4}${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n {4}\\}`));
    assert.ok(match, `production ${name} method exists`);
    return match[0];
});
// Keep the actual signal handler too, so opening/closing tests cover its calls.
const onOpen = source.match(/this\.menu\.connect\('open-state-changed', ([\s\S]*?)\n {8}\}\);/);
assert.ok(onOpen);
const onBinary = source.match(/this\._settings\.connect\('changed::binary-path', ([\s\S]*?)\n {12}\}\),/);
assert.ok(onBinary);

function harness(mode = 'background') {
    let nowMs = Date.now();
    let nextId = 0;
    const timers = new Map();
    const processes = [];
    const values = {'binary-path': '/stub/old', 'menu-refresh-mode': mode,
        'menu-refresh-interval': 300, 'menu-max-age': 60};
    class Subprocess {
        constructor({argv}) { this.argv = argv; }
        init() { processes.push(this); }
        communicate_utf8_async(_input, _cancel, callback) { this.callback = callback; }
        communicate_utf8_finish() { return [true, '{"entries":[]}', '']; }
        get_successful() { return true; }
        force_exit() {}
        finish() { this.callback(this, {}); }
    }
    const indicator = runInNewContext(`({
        ${implementations.join(',')},
        connectHandlers() {
            this.openChanged = ${onOpen[1]}\n        };
            this.binaryChanged = ${onBinary[1]}\n            };
        }
    })`, {
        Date: {now: () => nowMs}, commandFailure, errorLine, reportOutdated,
        parseReport: raw => parseReport(raw, nowMs),
        resolveBinary: settings => settings.get_string('binary-path'),
        Gio: {Subprocess, SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2},
            Cancellable: class { cancel() {} }},
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
            timeout_add_seconds(_priority, _seconds, callback) {
                timers.set(++nextId, callback);
                return nextId;
            },
            source_remove: id => timers.delete(id)},
    });
    Object.assign(indicator, {
        _settings: {get_string: k => values[k], get_int: k => values[k]},
        _reportJob: {busy: false, pending: false, token: 0, timeoutId: 0},
        _reportAt: nowMs - 120000, _reportRaw: null, _memo: {},
        menu: {isOpen: false},
        _syncRefreshItem() {}, _paintReport() {}, _refresh() {},
        _startTick() {}, _stopTick() {}, _commandTimeout: () => 120,
    });
    indicator.connectHandlers();
    return {indicator, processes, values,
        now: () => nowMs,
        advance: ms => { nowMs += ms; },
        open(value) {
            indicator.menu.isOpen = value;
            indicator.openChanged(null, value);
        },
        tick: () => timers.get(indicator._reportTimer)(),
        timeout: () => timers.get(indicator._reportJob.timeoutId)(),
    };
}

// Local ticks update both the marker and its caption from a held report,
// without launching a command or changing the last-received timestamp.
{
    const {indicator: i, processes, now, advance} = harness();
    i._reportArrived(JSON.stringify({entries: [{id: 'anthropic', sections: [{
        type: 'metric', label: 'Session (5h)', percent: 60,
        reset_at: new Date(now() + 150 * 60000).toISOString(), window_secs: 18000,
        detail: 'Resets in 2h 30m · 50% elapsed · 10pts ahead',
    }]}]}), '', true);
    const receivedAt = i._reportAt;
    advance(30 * 60000);
    i._tick();
    const row = i._report.entries[0].rows[0];
    assert.equal(row.elapsed, 60);
    assert.equal(row.detail, '60% elapsed · on track');
    assert.equal(row.reset, '2h 0m');
    assert.equal(i._reportAt, receivedAt);
    assert.equal(processes.length, 0);
}

// Opening onto an old report while a background fetch runs shares that fetch.
{
    const {indicator: i, processes, open} = harness();
    i._refreshReport();
    open(true);
    processes[0].finish();
    assert.equal(processes.length, 1, 'opening during a fetch must not start a second pass');
    assert.equal(i._reportJob.busy, false);
    assert.equal(i._report.ok, true);
}

// Reopening and timer ticks during a slow on-open fetch cannot leave work
// behind that launches after the user closes the menu.
for (const result of ['success', 'timeout']) {
    const {indicator: i, processes, open, tick, timeout} = harness('on-open');
    i._restartReportTimer();
    tick();
    assert.equal(processes.length, 0, 'closed on-open menu stays idle');
    open(true);
    tick();
    open(false);
    open(true);
    open(false);
    if (result === 'timeout') timeout();
    processes[0].finish();
    tick();
    assert.equal(processes.length, 1, `${result}: no queued process after closing`);
    assert.equal(i._reportJob.busy, false);
}

// Busy timer ticks coalesce, but the next scheduled tick still refreshes.
{
    const {indicator: i, processes, tick} = harness();
    i._restartReportTimer();
    tick();
    tick();
    processes[0].finish();
    assert.equal(processes.length, 1);
    tick();
    assert.equal(processes.length, 2);
}

// Changing mode during a fetch must not strand a queued automatic refresh.
{
    const {indicator: i, processes, values, tick} = harness();
    i._restartReportTimer();
    tick();
    values['menu-refresh-mode'] = 'on-open';
    i._restartReportTimer();
    processes[0].finish();
    assert.equal(processes.length, 1);
    i._reportAt = Date.now() - 600000;
    values['menu-refresh-mode'] = 'background';
    i._restartReportTimer();
    assert.equal(processes.length, 2, 'background mode still catches up');
}

// Source changes are different: the in-flight report came from another binary.
// Repeated changes collapse into one follow-up using the latest path.
{
    const {indicator: i, processes, values, open} = harness('on-open');
    open(true);
    values['binary-path'] = '/stub/intermediate';
    i.binaryChanged();
    values['binary-path'] = '/stub/new';
    i.binaryChanged();
    open(false);
    processes[0].finish();
    assert.equal(processes.length, 2, 'explicit source changes must not be dropped');
    assert.equal(processes[1].argv[0], '/stub/new');
    processes[1].finish();
    assert.equal(processes.length, 2);
}

console.log('GNOME refresh scheduling tests passed');
