import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// A Windows checkout with core.autocrlf has CRLF endings; the contract regexes
// are written against LF.
const source = readFileSync(new URL('./extension.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const helper = source.match(/\r?\nfunction verticalBox\([^)]*\) \{\r?\n[\s\S]*?\r?\n\}\r?\n/);
assert.ok(helper, 'vertical layouts must handle both Shell property names');
assert.doesNotMatch(source.replace(helper[0], ''), /\b(?:orientation|vertical)\s*:/);

// Execute the actual helper against each API shape. Unsupported properties
// throw, as GJS does, and the caller's layout properties must survive.
for (const modern of [false, true]) {
    const result = runInNewContext(`${helper[0]}\nverticalBox({x_expand: true});`, {
        HAS_ORIENTATION: modern,
        Clutter: {Orientation: {VERTICAL: 1}},
        St: {BoxLayout: class {
            constructor(props) {
                assert.ok(!((modern ? 'vertical' : 'orientation') in props));
                Object.assign(this, props);
            }
        }},
    });
    assert.equal(result.x_expand, true);
    assert.equal(modern ? result.orientation : result.vertical, modern ? 1 : true);
}

// The top bar swaps its label for an icon when there is nothing to draw. That
// only holds if every panel write goes through the helper that makes the swap.
const panelWrites = source.match(/\b_label\.clutter_text\.set_markup\(/g) ?? [];
assert.equal(panelWrites.length, 1, 'top-bar markup must go through _setPanelMarkup');
assert.match(source, /\n {4}_setPanelMarkup\(markup\) \{\n[\s\S]*?this\._label\.clutter_text\.set_markup\(markup\);/);

// Native bars are placed from their allocation. A detail bar is stretched past
// the width it asks for, so geometry from the requested width drew 100% short.
assert.doesNotMatch(source, /\bwidth \* (?:percent|elapsed) \/ 100/, 'bar geometry goes through barGeometry');
assert.match(source, /class AiUsageBarTrack extends St\.Widget[\s\S]*?vfunc_allocate\(box\) \{[\s\S]*?barGeometry\(box\.get_width\(\)/);

// "Refresh now" keeps the menu open. A menu action closes it, and so does an
// item whose activate() emits 'activate', which is what PopupMenu listens for.
assert.doesNotMatch(source, /addAction\(\s*'Refresh now'/, 'Refresh now must not be a closing menu action');
const refreshActivate = source.match(/class AiUsageBarRefreshItem[\s\S]*?\n {4}activate\(_event\) \{\n([\s\S]*?)\n {4}\}/);
assert.ok(refreshActivate, 'the refresh item overrides activate');
assert.doesNotMatch(refreshActivate[1], /emit\(|super\.activate/);

// The refresh row reports progress only if every busy change reaches it.
const busyWrites = source.match(/\bjob\.busy\s*=[^=]/g) ?? [];
assert.equal(busyWrites.length, 1, 'job.busy must change only through _setBusy');
assert.match(source, /\n {4}_setBusy\(job, busy\) \{\n {8}job\.busy = busy;/);

console.log('GNOME layout compatibility tests passed');
