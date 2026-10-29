// Tiny bar-chart of recent values, drawn with Cairo.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const HISTORY = 40;

export const Sparkline = GObject.registerClass(
class PulseBarSparkline extends St.DrawingArea {
    _init(rgb) {
        super._init({style_class: 'pulse-bar-spark', y_align: Clutter.ActorAlign.CENTER});
        this._rgb = rgb;
        this._values = [];
        this._max = 100;
    }

    setColor(rgb) {
        this._rgb = rgb;
        this.queue_repaint();
    }

    // max: value that fills the full height; null scales to the largest value shown.
    setValues(values, max = 100) {
        this._values = values;
        this._max = max;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const max = this._max ?? Math.max(1, ...this._values.filter(v => v !== null));
        const step = w / HISTORY;
        const barW = Math.max(1, step - 1);
        const [r, g, b] = this._rgb;

        cr.setSourceRGBA(r, g, b, 0.12);
        cr.rectangle(0, h - 1, w, 1);
        cr.fill();

        cr.setSourceRGBA(r, g, b, 0.85);
        const offset = HISTORY - this._values.length;
        this._values.forEach((v, i) => {
            if (v === null)
                return;
            const bh = Math.max(1, Math.min(1, v / max) * h);
            cr.rectangle((offset + i) * step, h - bh, barW, bh);
        });
        cr.fill();
        cr.$dispose();
    }
});
