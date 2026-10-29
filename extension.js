import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as P from './lib/parse.js';
import {Sensors} from './lib/sensors.js';
import {Sparkline, HISTORY} from './lib/sparkline.js';

// Series colours for dark and light themes; picked from the theme's text colour.
const PALETTES = {
    dark: {
        cpu: [1.0, 0.82, 0.4],
        gpu: [0.37, 0.95, 0.63],
        ram: [0.48, 0.64, 1.0],
        disk: [1.0, 0.48, 0.35],
        net: [0.75, 0.6, 1.0],
    },
    light: {
        cpu: [0.75, 0.5, 0.0],
        gpu: [0.05, 0.58, 0.3],
        ram: [0.16, 0.4, 0.86],
        disk: [0.86, 0.3, 0.14],
        net: [0.52, 0.3, 0.86],
    },
};
const SERIES = ['cpu', 'gpu', 'ram', 'disk', 'net'];

// Usage percentages turn yellow/red at these; temperatures use the user's settings.
const USAGE_WARN = 60;
const USAGE_CRIT = 85;

const css = ([r, g, b]) => `color: rgb(${r * 255}, ${g * 255}, ${b * 255});`;

// Dark text means a light background. Clutter.Color (≤46) has 0-255 fields;
// Cogl.Color (47+) exposes the same fields.
function isLightTheme(actor) {
    const fg = actor.get_theme_node().get_foreground_color();
    return 0.299 * fg.red + 0.587 * fg.green + 0.114 * fg.blue < 128;
}

const Indicator = GObject.registerClass(
class PulseBarIndicator extends PanelMenu.Button {
    _init(ext, settings) {
        super._init(0.5, 'Pulse Bar');
        this._ext = ext;
        this._settings = settings;
        this._history = {cpu: [], gpu: [], ram: [], disk: [], net: []};
        this._last = null;

        this._box = new St.BoxLayout({style_class: 'pulse-bar-box'});
        this.add_child(this._box);
        this._pills = {
            cpu: this._addPill('CPU'),
            gpu: this._addPill('GPU'),
            ram: this._addPill('RAM'),
            net: this._addPill('NET'),
        };
        this._pills.cpu.value.text = '…';

        this._rows = {
            cpu: this._addRow('CPU', true),
            gpu: this._addRow('GPU', true),
            ram: this._addRow('RAM', true),
            disk: this._addRow('SSD', true),
            net: this._addRow('NET', true),
            fans: this._addRow('FAN', false),
            bat: this._addRow('BAT', false),
        };
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => this._ext.openPreferences());
        this.connect('style-changed', () => {
            if (isLightTheme(this))
                this._box.add_style_class_name('pulse-bar-light');
            else
                this._box.remove_style_class_name('pulse-bar-light');
        });
        this.menu.box.connect('style-changed', () => this._applyMenuPalette());
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open && this._last)
                this._renderMenu(this._last);
        });

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            // Only restart a running timer; before discovery finishes there is none.
            if (key === 'refresh-interval' && this._timerId)
                this._startTimer();
            if (this._last)
                this._render(this._last);
        });

        this._sensors = new Sensors();
        this._sensors.discover().then(() => {
            if (this._sensors)
                this._startTimer();
        }).catch(e => logError(e, 'pulse-bar'));
    }

    _addPill(name) {
        const box = new St.BoxLayout({style_class: 'pulse-bar-pill', y_align: Clutter.ActorAlign.CENTER});
        const mk = cls => new St.Label({style_class: cls, y_align: Clutter.ActorAlign.CENTER});
        const pill = {box, name: mk('pulse-bar-name'), value: mk('pulse-bar-value'), extra: mk('pulse-bar-value')};
        pill.name.text = name;
        box.add_child(pill.name);
        box.add_child(pill.value);
        box.add_child(pill.extra);
        this._box.add_child(box);
        return pill;
    }

    _addRow(name, withSpark) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const nameLabel = new St.Label({text: name, style_class: 'pulse-bar-row-name', y_align: Clutter.ActorAlign.CENTER});
        const detail = new St.Label({style_class: 'pulse-bar-row-detail', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        item.add_child(nameLabel);
        item.add_child(detail);
        let spark = null;
        if (withSpark) {
            spark = new Sparkline(PALETTES.dark.cpu);
            item.add_child(spark);
        }
        this.menu.addMenuItem(item);
        return {item, nameLabel, detail, spark};
    }

    _applyMenuPalette() {
        const palette = PALETTES[isLightTheme(this.menu.box) ? 'light' : 'dark'];
        for (const key of SERIES) {
            this._rows[key].nameLabel.style = css(palette[key]);
            this._rows[key].spark.setColor(palette[key]);
        }
    }

    _startTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._settings.get_int('refresh-interval'), () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._tick();
    }

    async _tick() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const s = await this._sensors.sample();
            if (!this._sensors)
                return;
            this._pushHistory(s);
            this._last = s;
            this._render(s);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'pulse-bar');
        } finally {
            this._busy = false;
        }
    }

    _pushHistory(s) {
        const push = (key, v) => {
            const h = this._history[key];
            h.push(v ?? null);
            if (h.length > HISTORY)
                h.shift();
        };
        push('cpu', s.cpu.percent);
        push('gpu', s.gpu?.util);
        push('ram', s.mem ? 100 * s.mem.used / s.mem.total : null);
        push('disk', s.disk.read === null ? null : s.disk.read + s.disk.write);
        push('net', s.net.down === null ? null : s.net.down + s.net.up);
    }

    _render(s) {
        this._renderPanel(s);
        if (this.menu.isOpen)
            this._renderMenu(s);
    }

    _tempText(c) {
        return P.formatTemp(c, this._settings.get_string('temp-unit'));
    }

    _tempLevel(c) {
        return P.level(c, this._settings.get_int('temp-warn'), this._settings.get_int('temp-crit'));
    }

    _renderPanel(s) {
        const set = this._settings;
        const showTemps = set.get_boolean('show-temps');
        const color = (label, lvl) => (label.style_class = `pulse-bar-value pulse-bar-${lvl}`);
        const {cpu, gpu, ram, net} = this._pills;

        cpu.box.visible = set.get_boolean('show-cpu');
        cpu.value.text = P.formatPercent(s.cpu.percent);
        color(cpu.value, P.level(s.cpu.percent, USAGE_WARN, USAGE_CRIT));
        cpu.extra.visible = showTemps && s.cpu.temp !== null;
        cpu.extra.text = this._tempText(s.cpu.temp).padStart(4);
        color(cpu.extra, this._tempLevel(s.cpu.temp));

        gpu.box.visible = set.get_boolean('show-gpu') && s.gpu !== null;
        if (s.gpu?.sleeping) {
            gpu.value.text = 'off';
            color(gpu.value, 'idle');
            gpu.extra.visible = false;
        } else if (s.gpu) {
            gpu.value.text = P.formatPercent(s.gpu.util);
            color(gpu.value, P.level(s.gpu.util, USAGE_WARN, USAGE_CRIT));
            gpu.extra.visible = showTemps && s.gpu.temp !== null;
            gpu.extra.text = this._tempText(s.gpu.temp).padStart(4);
            color(gpu.extra, this._tempLevel(s.gpu.temp));
        }

        ram.box.visible = set.get_boolean('show-ram') && s.mem !== null;
        if (s.mem) {
            const pct = 100 * s.mem.used / s.mem.total;
            ram.value.text = P.formatSize(s.mem.used).padStart(4);
            color(ram.value, P.level(pct, 75, 90));
        }
        ram.extra.visible = false;

        net.box.visible = set.get_boolean('show-net');
        net.value.text = `↓${P.formatSize(s.net.down ?? 0).padStart(4)}`;
        net.extra.text = `↑${P.formatSize(s.net.up ?? 0).padStart(4)}`;
        color(net.value, 'ok');
        color(net.extra, 'ok');
    }

    _renderMenu(s) {
        const r = this._rows;
        const h = this._history;

        r.cpu.detail.text = [
            P.formatPercent(s.cpu.percent).trim(),
            this._tempText(s.cpu.temp),
            s.cpu.mhz ? `${(s.cpu.mhz / 1000).toFixed(1)} GHz` : null,
        ].filter(Boolean).join('  ·  ');
        r.cpu.spark.setValues(h.cpu);

        r.gpu.item.visible = s.gpu !== null;
        if (s.gpu?.sleeping) {
            r.gpu.detail.text = 'asleep (not polled, saves battery)';
        } else if (s.gpu) {
            r.gpu.detail.text = [
                P.formatPercent(s.gpu.util).trim(),
                this._tempText(s.gpu.temp),
                s.gpu.memTotal ? `${P.formatSize(s.gpu.memUsed)} / ${P.formatSize(s.gpu.memTotal)}` : null,
            ].filter(Boolean).join('  ·  ');
        }
        r.gpu.spark.setValues(h.gpu);

        if (s.mem) {
            r.ram.detail.text = `${P.formatSize(s.mem.used)} / ${P.formatSize(s.mem.total)}  ·  ` +
                `${Math.round(100 * s.mem.used / s.mem.total)}%`;
        }
        r.ram.spark.setValues(h.ram);

        r.disk.detail.text = [
            s.disk.temp !== null ? this._tempText(s.disk.temp) : null,
            `↓${P.formatRate(s.disk.read)}  ↑${P.formatRate(s.disk.write)}`,
        ].filter(Boolean).join('  ·  ');
        r.disk.spark.setValues(h.disk, null);

        r.net.detail.text = `↓${P.formatRate(s.net.down)}  ↑${P.formatRate(s.net.up)}`;
        r.net.spark.setValues(h.net, null);

        r.fans.item.visible = s.fans.length > 0;
        r.fans.detail.text = s.fans.map(f => `${f.label.replace(/\s*fan\s*/i, ' ').trim()} ${f.rpm}`)
            .join('  ·  ') + ' rpm';

        r.bat.item.visible = s.battery !== null;
        if (s.battery)
            r.bat.detail.text = `${s.battery.capacity}%  ·  ${s.battery.status.toLowerCase()}`;
    }

    destroy() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = null;
        this._settings.disconnect(this._settingsId);
        this._sensors.destroy();
        this._sensors = null;
        super.destroy();
    }
});

export default class PulseBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._addIndicator();
        this._positionId = this._settings.connect('changed::panel-position', () => {
            this._indicator.destroy();
            this._addIndicator();
        });
    }

    _addIndicator() {
        const position = this._settings.get_string('panel-position');
        this._indicator = new Indicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator, position === 'right' ? 0 : -1, position);
    }

    disable() {
        this._settings.disconnect(this._positionId);
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
