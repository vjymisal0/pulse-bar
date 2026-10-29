import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function comboRow(settings, key, title, choices) {
    const values = choices.map(c => c[0]);
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(choices.map(c => c[1]))});
    row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    return row;
}

function intSpinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class PulseBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const bar = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'What shows next to the clock. The click-open panel always shows everything.',
        });
        page.add(bar);
        for (const [key, title] of [
            ['show-cpu', 'CPU usage'],
            ['show-gpu', 'GPU usage'],
            ['show-ram', 'RAM used'],
            ['show-temps', 'CPU and GPU temperatures'],
            ['show-net', 'Network speed'],
        ]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            bar.add(row);
        }
        bar.add(comboRow(settings, 'panel-position', 'Position', [
            ['left', 'Left'], ['center', 'Center'], ['right', 'Right'],
        ]));

        const general = new Adw.PreferencesGroup({title: 'General'});
        page.add(general);
        general.add(intSpinRow(settings, 'refresh-interval', 'Refresh every',
            'Milliseconds. Lower is livelier, higher uses less power.', 500, 10000, 250));
        general.add(comboRow(settings, 'temp-unit', 'Temperature unit', [
            ['C', 'Celsius (°C)'], ['F', 'Fahrenheit (°F)'],
        ]));

        const temps = new Adw.PreferencesGroup({
            title: 'Temperature colours',
            description: 'Set in °C, whatever unit is displayed.',
        });
        page.add(temps);
        temps.add(intSpinRow(settings, 'temp-warn', 'Yellow from', null, 30, 110, 1));
        temps.add(intSpinRow(settings, 'temp-crit', 'Red from', null, 30, 110, 1));
    }
}
