// Snowcast — сніг на робочому столі GNOME
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {UpdateChecker} from './lib/updates.js';

const COLW = 3;          // ширина однієї «колонки» снігу, px
const CAP_BAND = 46;
const PREVIEW_BAND = 48;    // висота смужки зі снігом над мініатюрою вікна в огляді     // макс. можлива висота «гірки» на вікні, px
const TAU = Math.PI * 2;
const PLOW_SPEED = 115;  // px/с

const CAP_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
]);

// ---------- helpers ----------
function resample(arr, n) {
    const out = new Float32Array(n);
    if (!arr || arr.length === 0)
        return out;
    for (let i = 0; i < n; i++)
        out[i] = arr[Math.min(arr.length - 1, Math.floor(i * arr.length / n))];
    return out;
}

// c — «місткість» кожної колонки (профіль гірки). Те, що не влізло, стікає схилом.
function deposit(h, c, i, amount) {
    const n = h.length;
    const put = (j, v) => {
        if (j < 0 || j >= n)
            return v;
        const add = Math.min(Math.max(0, c[j] - h[j]), v);
        h[j] += add;
        return v - add;
    };
    let rest = put(i, amount * 0.5) + put(i - 1, amount * 0.25) + put(i + 1, amount * 0.25);
    let j = i;
    for (let step = 0; step < 10 && rest > 0.01; step++) {
        const lr = j - 1 >= 0 ? c[j - 1] - h[j - 1] : -1;
        const rr = j + 1 < n ? c[j + 1] - h[j + 1] : -1;
        j = lr > rr ? j - 1 : j + 1;
        if (j < 0 || j >= n)
            break;
        rest = put(j, rest);
    }
    return rest;
}

// осідання снігу: занадто круті схили обсипаються в сусідні колонки
function relax(h, c, limit) {
    for (let i = 0; i < h.length - 1; i++) {
        const d = h[i] - h[i + 1];
        if (d > limit) {
            const m = Math.min(d * 0.22, Math.max(0, c[i + 1] - h[i + 1]));
            h[i] -= m;
            h[i + 1] += m;
        } else if (d < -limit) {
            const m = Math.min(-d * 0.22, Math.max(0, c[i] - h[i]));
            h[i + 1] -= m;
            h[i] += m;
        }
    }
}

// профіль гірок: кілька горбів різної висоти, схили до країв
// детермінований «шум» для вузла j (той самий вузол завжди дає те саме значення)
function hash01(seed, j) {
    let x = (Math.imul(j ^ 0x27d4eb2d, 0x85ebca6b) ^ (seed >>> 0)) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x / 4294967296;
}

function smoothNoise(seed, pos, wl) {
    const x = pos / wl, j = Math.floor(x), u = (1 - Math.cos((x - j) * Math.PI)) / 2;
    return hash01(seed, j) * (1 - u) + hash01(seed, j + 1) * u;
}

// профіль гірок: горби різної висоти. start — номер першої колонки в «системі координат»
// поверхні, тож при зміні ширини горби лишаються на місці, а не перемальовуються заново
function hillProfile(n, seed, peak, minFrac, wavelength, start = 0) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const pos = start + i;
        const noise = Math.pow(0.7 * smoothNoise(seed, pos, wavelength) +
            0.3 * smoothNoise(seed + 7, pos, Math.max(4, wavelength / 3)), 1.5);
        out[i] = peak * (minFrac + (1 - minFrac) * noise);
    }
    return out;
}

function themeRadius(actor) {
    try {
        return actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT) || 0;
    } catch (e) {
        return 0;
    }
}

function hex(cr, color, a = 1) {
    const n = parseInt(color.slice(1), 16);
    cr.setSourceRGBA(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a);
}

function roundRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function ellipse(cr, cx, cy, rx, ry) {
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.newSubPath();
    cr.arc(0, 0, 1, 0, TAU);
    cr.restore();
}

function newPlow() {
    return {active: false, s: 0, px: -1e4, py: 0, angle: 0, dir: 1, next: 8 + Math.random() * 6, wheel: 0, pile: 0, beacon: 0, smoke: 0};
}

// ---------- двигун снігу ----------
class SnowEngine {
    constructor(settings) {
        this._settings = settings;
        this._flakes = [];
        this._puffs = [];
        this._grounds = [];
        this._caps = new Map();      // stable_sequence -> {h, lastX, lastY}
        this._windows = [];
        this._time = 0;
        this._last = 0;
        this._pruneT = 0;
        this._forcePlow = false;
        this._mouse = {x: -1e5, y: -1e5, init: false};

        this._readConfig();
        this._settingsId = settings.connect('changed', () => this._readConfig());

        this._area = new St.DrawingArea({reactive: false, x: 0, y: 0});
        this._area.connect('repaint', area => this._draw(area));
        Main.layoutManager.uiGroup.insert_child_above(this._area, global.window_group);

        // окремий шар «фону» для огляду (Super): його копії ставимо у фон робочих просторів,
        // як це робить Desktop Widgets. Сам шар невидимий (opacity 0) — Clone малює його повністю.
        this._bgArea = new St.DrawingArea({reactive: false, opacity: 0});
        this._bgArea.connect('repaint', area => this._drawOverviewLayer(area));
        Main.layoutManager.uiGroup.insert_child_at_index(this._bgArea, 0);
        this._ovClones = new Map();
        this._ovIds = [
            Main.overview.connect('showing', () => this._syncOverviewClones()),
            Main.overview.connect('shown', () => this._syncOverviewClones()),
            Main.overview.connect('hidden', () => {
                this._clearOverviewClones();
                this._clearPreviewSnow();
            }),
        ];

        // закриття і згортання вікон: сніг з них обсипається одразу, з початком анімації
        this._closing = new Set();
        this._widgetHooks = [];
        this._prevDockKeys = new Set();
        this._wmIds = [
            global.window_manager.connect('destroy', (_wm, actor) => this._onWindowGone(actor, true)),
            global.window_manager.connect('minimize', (_wm, actor) => this._onWindowGone(actor, false)),
        ];

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._setupMonitors());
        this._setupMonitors();

        this._timeline = new Clutter.Timeline({actor: global.stage, duration: 1000, repeat_count: -1});
        this._frameId = this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
    }

    destroy() {
        this._timeline.disconnect(this._frameId);
        this._timeline.stop();
        this._timeline = null;
        Main.layoutManager.disconnect(this._monitorsId);
        this._settings.disconnect(this._settingsId);
        for (const id of this._wmIds)
            global.window_manager.disconnect(id);
        for (const [actor, id] of this._widgetHooks) {
            try {
                actor.disconnect(id);
            } catch (e) {
                // актор уже знищено
            }
        }
        this._widgetHooks = [];
        for (const id of this._ovIds)
            Main.overview.disconnect(id);
        this._clearOverviewClones();
        this._clearPreviewSnow();
        this._bgArea.destroy();
        this._bgArea = null;
        this._area.destroy();
        this._area = null;
        this._caps.clear();
    }

    _readConfig() {
        const s = this._settings;
        this._cfg = {
            intensity: s.get_int('intensity'),
            maxSnow: s.get_int('max-snow'),
            windowSnow: s.get_boolean('window-snow'),
            shakeOff: s.get_boolean('shake-off'),
            plow: s.get_boolean('plow-enabled'),
            plowInterval: s.get_int('plow-interval'),
            cursor: s.get_boolean('cursor-clear'),
            hideFs: s.get_boolean('hide-on-fullscreen'),
            winRadius: s.settings_schema.has_key('window-radius') ? s.get_int('window-radius') : 16,
            windAngle: s.settings_schema.has_key('wind-angle') ? s.get_int('wind-angle') : 0,
            gusts: s.settings_schema.has_key('wind-gusts') ? s.get_boolean('wind-gusts') : true,
            snowfall: s.settings_schema.has_key('snowfall') ? s.get_boolean('snowfall') : true,
            hideFocused: s.settings_schema.has_key('hide-over-focused') ? s.get_boolean('hide-over-focused') : false,
            fps: s.get_int('frame-rate'),
        };
        if (!this._cfg.windowSnow)
            this._windows = [];
        if (this._grounds)
            this._groundProfiles();
        if (this._caps) {
            for (const c of this._caps.values())
                c.shapeKey = null;
        }
    }

    _groundProfiles() {
        for (const g of this._grounds)
            g.c = hillProfile(g.h.length, g.seed | 0, this._cfg.maxSnow, 0.4, 70);
    }

    _setupMonitors() {
        const old = this._grounds;
        let maxX = 0, maxY = 0;
        this._grounds = Main.layoutManager.monitors.map((m, i) => {
            maxX = Math.max(maxX, m.x + m.width);
            maxY = Math.max(maxY, m.y + m.height);
            const n = Math.ceil(m.width / COLW) + 1;
            const prev = old[i];
            return {
                x: m.x, y: m.y, width: m.width, height: m.height,
                h: prev ? resample(prev.h, n) : new Float32Array(n),
                plow: prev ? prev.plow : newPlow(),
                seed: prev ? prev.seed : Math.random() * 1e9,
            };
        });
        this._groundProfiles();
        this._totalWidth = this._grounds.reduce((a, g) => a + g.width, 0) || 1;
        this._area.set_size(maxX, maxY);
        const pm = Main.layoutManager.primaryMonitor;
        if (pm)
            this._bgArea.set_size(pm.width, pm.height);
        this._flakes.length = 0;
    }

    // ---- публічні дії з меню ----
    clearAll() {
        for (const g of this._grounds) {
            g.h.fill(0);
            g.plow.pile = 0;
        }
        for (const c of this._caps.values())
            c.h.fill(0);
    }

    callPlow() {
        this._forcePlow = true;
        for (const g of this._grounds)
            g.plow.next = 0;
        for (const c of this._caps.values()) {
            if (c.plow)
                c.plow.next = 0;
        }
    }

    // ---- кадр ----
    _tick() {
        const now = GLib.get_monotonic_time() / 1e6;
        if (!this._last) {
            this._last = now;
            return;
        }
        let dt = now - this._last;
        const fps = this._animating ? Math.max(60, this._cfg.fps) : this._cfg.fps;
        if (dt < 0.9 / fps)
            return;
        this._last = now;
        dt = Math.min(dt, 0.05);

        const fw = global.display.get_focus_window();
        const hidden = this._cfg.hideFs && fw && fw.is_fullscreen();
        this._area.opacity = hidden ? 0 : 255;
        if (hidden)
            return;

        this._time += dt;
        this._readWindows(dt);
        this._updateFocusRect();
        this._updateObstacles();
        this._updatePointer(dt);
        this._updateFlakes(dt);
        this._updatePuffs(dt);
        for (const g of this._grounds) {
            relax(g.h, g.c, 1.2);
            this._updatePlow(g, dt);
        }
        for (const w of this._windows) {
            relax(w.cap.h, w.cap.c, 1.0);
            this._enforceCapacity(w);
        }
        this._updateCapPlows(dt);
        this._animating = this._windows.some(w => w.cap.animating) || this._capPlows.length > 0 ||
            this._grounds.some(g => g.plow.active);
        this._forcePlow = false;
        this._area.queue_repaint();
        if (this._ovClones.size)
            this._bgArea.queue_repaint();
        if (Main.overview.visible || Main.overview.visibleTarget)
            this._syncPreviewSnow();
    }

    // активне вікно, «перед» яким сніг не малюється (якщо ввімкнено в налаштуваннях)
    _updateFocusRect() {
        this._focusRect = null;
        if (!this._cfg.hideFocused)
            return;
        const fw = global.display.get_focus_window();
        if (!fw || fw.minimized || fw.is_fullscreen() || !CAP_TYPES.has(fw.get_window_type()))
            return;
        if (!fw.located_on_workspace(global.workspace_manager.get_active_workspace()))
            return;
        const r = fw.get_frame_rect();
        if (r.width < 40 || r.height < 20)
            return;
        this._focusRect = {
            x: r.x, y: r.y, width: r.width, height: r.height,
            radius: fw.is_maximized?.() ? 0 : Math.min(this._cfg.winRadius, r.width / 2, r.height / 2),
        };
    }

    // доки, що доходять до низу екрана: за ними сніг не збирається, а машинка їде по них
    _updateObstacles() {
        for (const g of this._grounds) {
            const B = g.y + g.height;
            g.obs = [];
            for (const w of this._windows) {
                const r = w.rect;
                if (w.isDock && r.y + r.height > B - 90 && r.x < g.x + g.width && r.x + r.width > g.x)
                    g.obs.push(r);
            }
            g.obs.sort((a, b) => a.x - b.x);
            for (const r of g.obs) {
                const i0 = Math.max(0, Math.floor((r.x - g.x) / COLW));
                const i1 = Math.min(g.h.length - 1, Math.ceil((r.x + r.width - g.x) / COLW));
                for (let i = i0; i <= i1; i++)
                    g.h[i] = 0;
            }
        }
    }

    _behindDock(g, x, y) {
        if (!g.obs)
            return false;
        for (const r of g.obs) {
            if (x >= r.x && x < r.x + r.width && y > r.y + 2)
                return true;
        }
        return false;
    }

    _readWindows(dt) {
        this._pruneT += dt;
        if (this._pruneT > 5) {
            this._pruneT = 0;
            const alive = new Set();
            for (const a of global.get_window_actors()) {
                const w = a.get_meta_window();
                if (w)
                    alive.add(w.get_stable_sequence());
            }
            for (const k of [...this._caps.keys()]) {
                if (typeof k === 'number' && !alive.has(k))
                    this._caps.delete(k);
            }
            for (const k of [...this._closing]) {
                if (!alive.has(k))
                    this._closing.delete(k);
            }
        }
        if (!this._cfg.windowSnow)
            return;

        const ws = global.workspace_manager.get_active_workspace();
        // віджети робочого столу лежать під усіма вікнами — на початок списку
        const list = this._getWidgets();
        for (const actor of global.get_window_actors()) {
            const w = actor.get_meta_window();
            if (!w || w.minimized || !actor.visible || this._closing.has(w.get_stable_sequence()))
                continue;
            if (!CAP_TYPES.has(w.get_window_type()) || !w.located_on_workspace(ws))
                continue;
            if (w.is_fullscreen())
                continue;
            const r = w.get_frame_rect();
            if (r.width < 40 || r.height < 20)
                continue;
            list.push({key: w.get_stable_sequence(), radius: w.is_maximized?.() ? 0 : this._cfg.winRadius,
                rect: {x: r.x, y: r.y, width: r.width, height: r.height}});
        }
        // док завжди над вікнами — додаємо його в кінець списку
        for (const d of this._getDocks())
            list.push(d);

        // list іде знизу догори (порядок накладання)
        for (let k = 0; k < list.length; k++) {
            const item = list[k];
            const R = item.rect;
            const key = item.key;
            const n = Math.max(1, Math.ceil(R.width / COLW));
            let cap = this._caps.get(key);
            if (!cap) {
                cap = {h: new Float32Array(n), lastX: R.x, lastY: R.y, lastW: R.width, anchorX: R.x};
                this._caps.set(key, cap);
            }

            // різко посунули вікно — сніг осипається
            const dx = R.x - cap.lastX, dy = R.y - cap.lastY;
            const dr = R.x + R.width - (cap.lastX + cap.lastW);
            // обидва краї зсунулись в один бік — це рух (можливо, з розгортанням вікна);
            // інакше — зміна розміру «по краях» (зокрема док, що росте від центру)
            const moved = Math.abs(dx) >= 3 && Math.abs(dr) >= 3 && Math.sign(dx) === Math.sign(dr);
            const resizedByEdge = cap.lastW !== R.width && !moved;
            cap.anchorX ??= R.x;
            if (cap.lastW === R.width)
                cap.anchorX += dx;            // горби їдуть разом з вікном
            else if (moved)
                cap.anchorX = R.x;
            const teleport = Math.hypot(dx, dy) > 250;
            const resizedTop = cap.lastH !== undefined && cap.lastH !== R.height &&
                Math.abs(R.y + R.height - (cap.lastY + cap.lastH)) < 3;
            if (resizedByEdge || teleport || !this._cfg.shakeOff) {
                cap.v = 0;
                cap.u = 0;
                cap.slide = 0;
            } else {
                this._inertia(cap, dx, dt, R);
            }
            if (teleport || resizedTop || !this._cfg.shakeOff) {
                cap.wv = 0;
                cap.lift = 0;
                cap.liftV = 0;
                cap.squash = 0;
                cap.squashV = 0;
                cap.animating = false;
            } else {
                this._bounce(cap, dy, dt, R);
            }
            cap.lastH = R.height;

            // змінили ширину — сніг з «відрізаної» частини падає вниз
            if (cap.lastW !== R.width)
                this._resizeCap(cap, R, n);
            cap.lastX = R.x;
            cap.lastY = R.y;
            cap.lastW = R.width;
            const radius = Math.max(0, Math.min(item.radius ?? 0, R.width / 2, 40));
            const start = Math.round((R.x - cap.anchorX) / COLW);
            const shapeKey = `${n}:${radius}:${start}:${R.width}`;
            if (!cap.c || cap.shapeKey !== shapeKey) {
                cap.shapeKey = shapeKey;
                cap.seed ??= (Math.random() * 1e9) | 0;
                const peak = Math.min(CAP_BAND - 4, 14 + R.width / 45);
                cap.c = hillProfile(n, cap.seed, peak, 0.2, 36, start);
                // Сніг тримається лише на рівній частині краю. Від початку заокруглення
                // він підіймається природним схилом (~35°), тож над кривою кута снігу немає.
                cap.off = new Float32Array(n);
                for (let i = 0; i < n; i++) {
                    const x = i * COLW + COLW / 2;
                    const flat = Math.min(x, R.width - x) - radius - 2;
                    cap.c[i] = Math.min(cap.c[i], Math.max(0, flat) * 0.7);
                }
            }

            // які колонки перекриті вікнами, що лежать вище
            const covered = new Uint8Array(n);
            for (let j = k + 1; j < list.length; j++) {
                const H = list[j].rect;
                if (H.y < R.y + 2 && H.y + H.height > R.y - CAP_BAND - 2) {
                    const a = Math.max(0, Math.floor((H.x - R.x) / COLW));
                    const b = Math.min(n, Math.ceil((H.x + H.width - R.x) / COLW));
                    for (let c = a; c < b; c++)
                        covered[c] = 1;
                }
            }
            item.cap = cap;
            item.covered = covered;
            cap.lastCovered = covered;
        }
        // док сховався (автоприховування, вимкнули) — сніг з нього обсипається
        const dockKeys = new Set(list.filter(i => i.isDock).map(i => i.key));
        for (const k of this._prevDockKeys) {
            if (!dockKeys.has(k))
                this._dropCap(k);
        }
        this._prevDockKeys = dockKeys;
        this._windows = list;
    }

    // вікно закрили або згорнули
    _onWindowGone(actor, closing) {
        if (!this._area)
            return;
        const w = actor?.get_meta_window?.();
        if (!w)
            return;
        const key = w.get_stable_sequence();
        if (closing)
            this._closing.add(key);
        this._dropCap(key);
    }

    // весь сніг з поверхні падає вниз грудочками (з того місця, де вона була востаннє)
    _dropCap(key) {
        const cap = this._caps.get(key);
        if (!cap || !cap.h)
            return;
        const h = cap.h, n = h.length;
        const cov = cap.lastCovered;
        for (let i = 0; i < n; i += 4) {
            let amount = 0, top = 0;
            for (let k = i; k < Math.min(i + 4, n); k++) {
                if (cov && cov[k])
                    continue;            // сніг під іншими вікнами просто зникає разом із вікном
                amount += h[k];
                top = Math.max(top, h[k]);
            }
            if (amount > 0.6)
                this._dropSnow(cap.lastX + i * COLW, cap.lastY - top, amount, (Math.random() - 0.5) * 30);
        }
        cap.h = new Float32Array(n);
        cap.lift = 0;
        cap.liftV = 0;
        cap.squash = 0;
        cap.squashV = 0;
        cap.animating = false;
    }

    // інерція: при різкому розгоні/гальмуванні вікна сніг ковзає,
    // і з краю падає лише той сніг, що з'їхав
    _inertia(cap, dx, dt, R) {
        const v = dx / dt;
        const a = Math.max(-25000, Math.min(25000, (v - (cap.v ?? 0)) / dt));
        cap.v = v;
        cap.u ??= 0;
        cap.slide ??= 0;
        const STATIC = 2500;   // слабкіші ривки сніг витримує (тертя спокою)
        const FRICTION = 1200; // тертя ковзання, px/с²
        if (Math.abs(a) > STATIC)
            cap.u += -a * 0.5 * dt;
        const f = FRICTION * dt;
        cap.u = Math.abs(cap.u) <= f ? 0 : cap.u - Math.sign(cap.u) * f;
        cap.u = Math.max(-500, Math.min(500, cap.u));
        cap.slide += cap.u * dt;
        if (cap.u === 0)
            cap.slide *= 0.5;
        const k = Math.trunc(cap.slide / COLW);
        if (k !== 0) {
            cap.slide -= k * COLW;
            this._slideCap(cap, k, R);
        }
    }

    // Сніг ніколи не лежить там, де поверхня його не втримає (над заокругленням, за краєм).
    // Надлишок зісковзує до найближчого краю і падає вниз.
    _enforceCapacity(w) {
        const cap = w.cap, h = cap.h, c = cap.c, n = h.length, R = w.rect;
        let spillL = 0, spillR = 0;
        for (let i = 0; i < n; i++) {
            const ex = h[i] - c[i];
            if (ex <= 0.02)
                continue;
            h[i] = c[i];
            if (i < n / 2)
                spillL += ex;
            else
                spillR += ex;
        }
        cap.spillL = (cap.spillL ?? 0) + spillL;
        cap.spillR = (cap.spillR ?? 0) + spillR;
        // крихти накопичуємо, а падають уже грудочками
        if (cap.spillL > 0.8) {
            this._dropSnow(R.x - 4, R.y - 2, cap.spillL, -(30 + Math.random() * 30));
            cap.spillL = 0;
        }
        if (cap.spillR > 0.8) {
            this._dropSnow(R.x + R.width + 1, R.y - 2, cap.spillR, 30 + Math.random() * 30);
            cap.spillR = 0;
        }
    }

    // підстрибування: різко смикнули вікно вниз або зупинили рух угору — сніг підлітає,
    // м'яко приземляється, сплющується і пружно погойдується
    _bounce(cap, dy, dt, R) {
        const G = 1400;            // «гравітація» снігу, px/с²
        const K = 420, C = 11;     // пружина сплющування (жорсткість, затухання)
        const wv = dy / dt;
        const ay = Math.max(-30000, Math.min(30000, (wv - (cap.wv ?? 0)) / dt));
        cap.wv = wv;
        cap.lift ??= 0;
        cap.liftV ??= 0;
        cap.squash ??= 0;
        cap.squashV ??= 0;

        const STEPS = 4, h = dt / STEPS;
        for (let k = 0; k < STEPS; k++) {
            // у системі вікна на сніг діє G - ay (вниз); якщо ay > G — сніг відривається
            if (cap.lift > 0 || ay > G)
                cap.liftV += (ay * 0.35 - G) * h;
            cap.liftV = Math.max(-1500, Math.min(420, cap.liftV));
            cap.lift += cap.liftV * h;
            if (cap.lift > 26) {
                cap.lift = 26;
                cap.liftV = Math.min(cap.liftV, 0);
            }
            if (cap.lift <= 0) {
                const impact = -cap.liftV;
                cap.lift = 0;
                cap.liftV = impact > 70 ? impact * 0.28 : 0; // невеликий відскок
                if (impact > 40)
                    cap.squashV += impact * 0.009;       // приземлення сплющує сніг
                if (impact > 280)
                    this._splash(cap, R, impact);
            }
            // пружина: сплющення повертається з легким погойдуванням
            cap.squashV += (-K * cap.squash - C * cap.squashV) * h;
            cap.squash += cap.squashV * h;
            cap.squash = Math.max(-0.25, Math.min(0.45, cap.squash));
        }
        cap.animating = cap.lift > 0.05 || Math.abs(cap.squash) > 0.004 || Math.abs(cap.squashV) > 0.02;
    }

    // форма снігу під час підстрибування: хвиля по ширині, витягування в польоті, сплющення
    _bounceShape(cap) {
        const n = cap.h.length;
        const lift = cap.lift ?? 0;
        const stretch = 1 + Math.max(-0.12, Math.min(0.22, (cap.liftV ?? 0) / 1800));
        const sq = cap.squash ?? 0;
        const hh = new Float32Array(n);
        const off = new Float32Array(n);
        const seed = (cap.seed ?? 0) % 100;
        for (let i = 0; i < n; i++) {
            const wave = 0.78 + 0.22 * Math.sin(i * 0.11 + seed + this._time * 5);
            // важчі (вищі) місця підлітають трохи менше
            const heavy = 1 / (1 + cap.h[i] / 40);
            off[i] = (cap.off?.[i] ?? 0) - lift * wave * (0.7 + 0.3 * heavy);
            hh[i] = cap.h[i] * stretch * (1 - sq);
        }
        return {h: hh, off};
    }

    // сильне приземлення: частина снігу розлітається
    _splash(cap, R, impact) {
        const h = cap.h;
        const frac = Math.min(0.12, impact / 8000);
        for (let i = 0; i < h.length; i++) {
            if (h[i] < 1 || Math.random() > 0.35)
                continue;
            const lost = h[i] * frac;
            h[i] -= lost;
            this._emit(R.x + i * COLW, R.y + (cap.off?.[i] ?? 0) - h[i], 0, -impact * 0.01, lost * 2, false);
        }
    }

    _slideCap(cap, k, R) {
        const old = cap.h, n = old.length;
        const h = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const j = i - k;
            if (j >= 0 && j < n)
                h[i] = old[j];
        }
        // колонки, що з'їхали за край, падають
        for (let j = 0; j < n; j++) {
            const i = j + k;
            if ((i < 0 || i >= n) && old[j] > 0.3)
                this._dropSnow(R.x + i * COLW, R.y - old[j], old[j], cap.u * 0.6 + cap.v * 0.3);
        }
        cap.h = h;
    }

    _resizeCap(cap, R, n) {
        const old = cap.h;
        const oldX = cap.lastX, oldY = cap.lastY;
        const oldW = cap.lastW ?? old.length * COLW;
        const dl = R.x - oldX, dr = R.x + R.width - (oldX + oldW);
        if (Math.abs(dl) >= 3 && Math.abs(dr) >= 3 && Math.sign(dl) === Math.sign(dr)) {
            // вікно і перемістилось, і змінило розмір (напр. розгорнули) — переносимо пропорційно
            cap.h = resample(old, n);
            cap.alignRem = 0;
            return;
        }
        // нова колонка i відповідає старій колонці i + offset (та сама точка на екрані);
        // так працює і зміна одного краю, і док, що росте/зменшується від центру.
        // Дробовий залишок накопичуємо, щоб зсув по 1 px за кадр не «тягнув» сніг за краєм.
        cap.alignRem = (cap.alignRem ?? 0) + dl / COLW;
        const offset = Math.round(cap.alignRem);
        cap.alignRem -= offset;
        const h = new Float32Array(n);
        const kept = new Uint8Array(old.length);
        for (let i = 0; i < n; i++) {
            const j = i + offset;
            if (j >= 0 && j < old.length) {
                h[i] = old[j];
                kept[j] = 1;
            }
        }
        for (let j = 0; j < old.length; j++) {
            if (!kept[j] && old[j] > 0.3)
                this._dropSnow(oldX + j * COLW, oldY - old[j], old[j], 0);
        }
        cap.h = h;
    }

    // грудки снігу, що падають вниз і лягають на інші вікна або на «землю»
    _dropSnow(x, y, amount, vx) {
        const count = Math.min(3, Math.max(1, Math.round(amount / 3)));
        for (let c = 0; c < count && this._puffs.length < 900; c++) {
            this._puffs.push({
                x: x + Math.random() * COLW,
                y: y + Math.random() * Math.min(amount, 6),
                vx: vx + (Math.random() - 0.5) * 30,
                vy: Math.random() * 40,
                r: 1 + Math.min(2.2, amount * 0.15) + Math.random(),
                life: 1, decay: 0.22, amount: amount / count, smoke: false,
            });
        }
    }

    // знайти, на який сніг (вікно/док) падає точка між py і y
    _capAt(x, py, y) {
        const wins = this._windows;
        for (let k = wins.length - 1; k >= 0; k--) {
            const W = wins[k], R = W.rect;
            if (x < R.x || x >= R.x + R.width)
                continue;
            const ci = ((x - R.x) / COLW) | 0;
            if (W.covered[ci])
                continue;
            const top = R.y + W.cap.off[ci] - W.cap.h[ci];
            if (py <= top && y >= top)
                return W.cap.h[ci] < W.cap.c[ci] - 0.05 ? {h: W.cap.h, c: W.cap.c, ci} : null;
        }
        return null;
    }

    // віджети розширення Desktop Widgets (шар 'widget-layer', у кожному віджеті актор з класом 'widget')
    _getWidgets() {
        if (!this._widgetLayers || this._time - this._widgetScanT > 3) {
            this._widgetScanT = this._time;
            const layers = [];
            const groups = [Main.layoutManager._backgroundGroup, global.window_group].filter(Boolean);
            for (const g of groups) {
                for (const c of g.get_children()) {
                    const sc = typeof c.get_style_class_name === 'function' ? c.get_style_class_name() : null;
                    if (sc && sc.split(/\s+/).includes('widget-layer'))
                        layers.push(c);
                }
            }
            this._widgetLayers = layers;
        }
        this._actorKeys ??= new WeakMap();
        this._keySeq ??= 0;
        // В огляді (Super) GNOME ховає справжній шар робочого столу, тож віджети «зникають».
        // Тоді беремо їхні останні відомі місця — і сніг на них видно в огляді.
        const inOverview = Main.overview.visible || Main.overview.visibleTarget;
        this._widgetRects ??= new Map();
        const out = [];
        for (const layer of this._widgetLayers) {
            try {
                if (!layer.get_stage())
                    continue;
                const layerMapped = layer.is_mapped();
                if (!layerMapped && !inOverview)
                    continue;
                for (const wrap of layer.get_children()) {
                    const isWidget = wrap.get_children().some(ch => {
                        const sc = typeof ch.get_style_class_name === 'function' ? ch.get_style_class_name() : null;
                        return sc && sc.split(/\s+/).includes('widget');
                    });
                    if (!isWidget)
                        continue;
                    let key = this._actorKeys.get(wrap);
                    if (!key) {
                        key = `wg${++this._keySeq}`;
                        this._actorKeys.set(wrap, key);
                        // віджет видалили — сніг з нього обсипається
                        const newKey = key;
                        const hook = [wrap, 0];
                        hook[1] = wrap.connect('destroy', () => {
                            this._widgetHooks = this._widgetHooks.filter(h => h !== hook);
                            if (!this._area)
                                return;
                            this._dropCap(newKey);
                            this._caps.delete(newKey);
                            this._widgetRects.delete(newKey);
                        });
                        this._widgetHooks.push(hook);
                    }

                    if (layerMapped && wrap.is_mapped() && wrap.get_paint_opacity() >= 10) {
                        const [x, y] = wrap.get_transformed_position();
                        const [w, h] = wrap.get_transformed_size();
                        if (!(w > 20 && h > 20) || y < 6)
                            continue;
                        const item = {key, radius: themeRadius(wrap),
                            rect: {x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h)}};
                        this._widgetRects.set(key, item);
                        out.push(item);
                    } else if (inOverview && this._widgetRects.has(key)) {
                        const last = this._widgetRects.get(key);
                        out.push({key, radius: last.radius, rect: {...last.rect}});
                    }
                }
            } catch (e) {
                this._widgetLayers = null;
            }
        }
        return out;
    }

    // док (Dash to Dock / Ubuntu Dock / вбудований dash) — шукаємо його фон
    _getDocks() {
        if (!this._dockActors || this._time - this._dockScanT > 3) {
            this._dockScanT = this._time;
            const found = [];
            const skip = new Set([global.window_group, Main.layoutManager.overviewGroup, this._area]);
            const walk = (a, depth) => {
                if (depth > 9)
                    return;
                for (const c of a.get_children()) {
                    if (skip.has(c))
                        continue;
                    const name = typeof c.get_name === 'function' ? c.get_name() : null;
                    if (name === 'd2daFakeDashBackground')
                        continue;
                    const sc = typeof c.get_style_class_name === 'function' ? c.get_style_class_name() : null;
                    if (name === 'd2daBackground' || (sc && sc.split(/\s+/).includes('dash-background'))) {
                        found.push(c);
                        continue;
                    }
                    walk(c, depth + 1);
                }
            };
            try {
                walk(Main.layoutManager.uiGroup, 0);
            } catch (e) {
                console.debug(`Snowcast: dock scan failed: ${e}`);
            }
            this._dockActors = found;
        }
        const out = [];
        this._dockActors.forEach((a, i) => {
            try {
                if (!a.get_stage() || !a.is_mapped() || a.get_paint_opacity() < 10)
                    return;
                const [x, y] = a.get_transformed_position();
                const [w, h] = a.get_transformed_size();
                if (!(w > 20 && h > 20) || y < 6 || x + w < 4 || x > global.stage.width - 4)
                    return;
                out.push({
                    isDock: true,
                    radius: Math.min(h / 2, themeRadius(a) || 16),
                    key: `dock${i}`,
                    rect: {x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h)},
                });
            } catch (e) {
                this._dockActors = null;
            }
        });
        return out;
    }

    // ---- сніжинки ----
    _pickGround() {
        let r = Math.random() * this._totalWidth;
        for (let i = 0; i < this._grounds.length; i++) {
            r -= this._grounds[i].width;
            if (r <= 0)
                return i;
        }
        return 0;
    }

    _newFlake(spread) {
        const gi = this._pickGround();
        const g = this._grounds[gi];
        const r = Math.random() ** 2 * 2.4 + 0.9;
        return {
            gi,
            x: g.x + Math.random() * (g.width + 60) - 30,
            y: spread ? g.y + Math.random() * g.height : g.y - 10 - Math.random() * 90,
            r,
            vx: 0,
            vy: 22 + r * 16 + Math.random() * 14,
            ph: Math.random() * TAU,
            sw: 0.5 + Math.random() * 1.4,
            a: 0.65 + Math.random() * 0.35,
        };
    }

    _updateFlakes(dt) {
        if (!this._grounds.length)
            return;
        const scale = Math.max(0.6, Math.min(2.5, this._totalWidth / 1600));
        // «Snowfall» вимкнено: нові сніжинки не з'являються, ті, що в повітрі, долітають
        const falling = this._cfg.snowfall;
        const target = Math.round(this._cfg.intensity * 3.2 * scale);
        const spread = this._time < 0.5;
        if (falling) {
            while (this._flakes.length < target)
                this._flakes.push(this._newFlake(spread));
            if (this._flakes.length > target)
                this._flakes.length = target;
        }
        const respawn = () => (falling ? this._newFlake(false) : null);
        // вимкнули — сніжинки в повітрі плавно тануть за 2,5 с; увімкнули — швидко проявляються
        this._flakeAlpha = falling
            ? Math.min(1, (this._flakeAlpha ?? 1) + dt * 2)
            : Math.max(0, (this._flakeAlpha ?? 1) - dt / 2.5);
        if (!falling && this._flakeAlpha <= 0) {
            this._flakes = [];
            return;
        }

        // напрямок снігу: кут від вертикалі (+ вправо, − вліво) і, за бажанням, пориви вітру
        const tanA = Math.tan(this._cfg.windAngle * Math.PI / 180);
        const gust = this._cfg.gusts
            ? Math.sin(this._time * 0.13) * 18 + Math.sin(this._time * 0.41) * 8
            : 0;
        const sway = this._cfg.gusts ? 12 : 7;
        this._windX = 40 * tanA + gust;
        const m = this._mouse;
        const maxSnow = this._cfg.maxSnow;
        for (let fi = 0; fi < this._flakes.length; fi++) {
            const f = this._flakes[fi];
            f.ph += dt * f.sw;
            f.vx += (f.vy * tanA + gust + Math.sin(f.ph) * sway - f.vx) * Math.min(1, dt * 2);

            // курсор розштовхує сніжинки
            if (this._cfg.cursor) {
                const dx = f.x - m.x, dy = f.y - m.y, d2 = dx * dx + dy * dy;
                if (d2 < 100) {
                    this._steam(f.x, f.y, 0.6);
                    this._flakes[fi] = respawn();
                    continue;
                }
                if (d2 < 3600) {
                    const d = Math.sqrt(d2), k = (60 - d) / 60 * 260 * dt;
                    f.x += dx / d * k;
                    f.y += dy / d * k * 0.5;
                }
            }

            const py = f.y;
            f.x += f.vx * dt;
            f.y += f.vy * dt;

            const g = this._grounds[f.gi];
            if (f.x < g.x - 40)
                f.x += g.width + 70;
            else if (f.x > g.x + g.width + 40)
                f.x -= g.width + 70;

            let landed = false;

            // вікна й док: сніг налипає одразу і швидко
            const hit = this._capAt(f.x, py, f.y);
            if (hit) {
                deposit(hit.h, hit.c, hit.ci, f.r * 6);
                landed = true;
            }

            // за доком сніг не падає
            if (!landed && this._behindDock(g, f.x, f.y))
                landed = true;

            // низ екрана
            if (!landed) {
                const gi = Math.max(0, Math.min(g.h.length - 1, Math.floor((f.x - g.x) / COLW)));
                if (f.y >= g.y + g.height - g.h[gi]) {
                    deposit(g.h, g.c, gi, f.r * 0.9);
                    landed = true;
                }
            }

            if (landed)
                this._flakes[fi] = respawn();
        }
        if (!falling)
            this._flakes = this._flakes.filter(Boolean);
    }

    // ---- курсор ----
    _updatePointer(dt) {
        const [x, y] = this._getPointer();
        const m = this._mouse;
        const vx = m.init ? x - m.x : 0, vy = m.init ? y - m.y : 0;
        m.x = x;
        m.y = y;
        m.init = true;
        this._heat = Math.max(0, (this._heat ?? 0) - dt * 2.5);
        if (!this._cfg.cursor)
            return;
        const speed = Math.min(1500, Math.hypot(vx, vy) / dt);

        // курсор «теплий»: розтоплює сніг під собою, навіть якщо стоїть
        const R = 24;
        const rate = (14 + speed / 25) * dt;
        let melted = 0;
        const melt = (h, x0, base, covered, off) => {
            const i0 = Math.max(0, Math.floor((x - R - x0) / COLW));
            const i1 = Math.min(h.length - 1, Math.ceil((x + R - x0) / COLW));
            for (let i = i0; i <= i1; i++) {
                if (h[i] < 0.2 || (covered && covered[i]))
                    continue;
                const cx = x0 + i * COLW;
                const surf = base + (off ? off[i] : 0) - h[i];
                if (y < surf - 16 || y > base + 10)
                    continue;
                const fall = 1 - Math.abs(cx - x) / R;
                if (fall <= 0)
                    continue;
                const take = Math.min(h[i], rate * fall * (0.6 + 0.4 * fall));
                h[i] -= take;
                melted += take;
                m.acc = (m.acc ?? 0) + take;
                if (m.acc > 0.9) {
                    m.acc = 0;
                    this._steam(cx, surf, 1);
                }
            }
        };

        for (const g of this._grounds) {
            if (x >= g.x - R && x <= g.x + g.width + R && y > g.y + g.height - this._cfg.maxSnow - 20)
                melt(g.h, g.x, g.y + g.height, null);
        }
        for (const w of this._windows) {
            const r = w.rect;
            if (x >= r.x - R && x <= r.x + r.width + R && y > r.y - CAP_BAND - 8 && y < r.y + 12)
                melt(w.cap.h, r.x, r.y, w.covered, w.cap.off);
        }
        if (melted > 0.01)
            this._heat = Math.min(1, this._heat + melted * 0.15);
    }

    // пар від розталого снігу
    _steam(x, y, size) {
        if (this._puffs.length >= 900)
            return;
        this._puffs.push({
            x: x + (Math.random() - 0.5) * 6,
            y: y - Math.random() * 3,
            vx: (Math.random() - 0.5) * 14 + (this._windX ?? 0) * 0.3,
            vy: -22 - Math.random() * 26,
            r: (1.2 + Math.random() * 1.6) * size,
            life: 1, decay: 0.85 + Math.random() * 0.4,
            seed: Math.random() * TAU,
            steam: true, smoke: false,
        });
    }

    _getPointer() {
        if (typeof global.get_pointer === 'function')
            return global.get_pointer();
        const tracker = global.backend.get_cursor_tracker();
        const [pt] = tracker.get_pointer();
        return [pt.x, pt.y];
    }

    // ---- частинки (розкиданий сніг і дим) ----
    _emit(x, y, vx, vy, amount, forward) {
        let n = Math.min(3, Math.round(amount * 0.6 + Math.random() * 0.7));
        while (n-- > 0 && this._puffs.length < 700) {
            this._puffs.push({
                x: x + (Math.random() - 0.5) * 4,
                y: y - Math.random() * 3,
                vx: forward ? vx : vx * 6 * (0.5 + Math.random()) + (Math.random() - 0.5) * 60,
                vy: forward ? vy : -60 - Math.random() * 120 + vy * 3,
                r: 0.8 + Math.random() * 1.8,
                life: 1,
                smoke: false,
            });
        }
    }

    _updatePuffs(dt) {
        const out = [];
        for (const p of this._puffs) {
            p.life -= dt * (p.decay ?? (p.smoke ? 0.8 : 0.7));
            if (p.life <= 0)
                continue;
            if (p.smoke || p.steam) {
                p.x += p.vx * dt;
                if (p.steam)
                    p.x += Math.sin(this._time * 3 + p.seed) * 8 * dt;
                p.y += p.vy * dt;
                p.vy *= 0.98;
                out.push(p);
                continue;
            }
            p.vy += 520 * dt;
            p.vx *= 0.985;
            const ppy = p.y;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.vy > 0 && p.amount) {
                const hit = this._capAt(p.x, ppy, p.y);
                if (hit) {
                    deposit(hit.h, hit.c, hit.ci, p.amount);
                    continue;
                }
            }
            const g = this._grounds.find(gg => p.x >= gg.x && p.x < gg.x + gg.width);
            if (g && this._behindDock(g, p.x, p.y))
                continue;
            if (!g) {
                if (p.y < 1e5)
                    out.push(p);
                continue;
            }
            const gi = Math.max(0, Math.min(g.h.length - 1, Math.floor((p.x - g.x) / COLW)));
            if (p.vy > 0 && p.y >= g.y + g.height - g.h[gi]) {
                if (p.amount)
                    deposit(g.h, g.c, gi, p.amount);
                else if (Math.random() < 0.5)
                    deposit(g.h, g.c, gi, p.r * 0.5);
                continue;
            }
            out.push(p);
        }
        this._puffs = out;
    }

    // ---- машинка ----
    // маршрут машинки: низ екрана, а через док — вгору по стінці, по верху і вниз
    _plowPath(g) {
        const B = g.y + g.height;
        const x0 = g.x - 90, x1 = g.x + g.width + 90;
        const pts = [[x0, B]];
        let endY = B;
        for (const r of g.obs ?? []) {
            const L = r.x, R = r.x + r.width, T = r.y;
            // док біля краю екрана: машинка заїжджає/виїжджає одразу по його верху
            if (L <= g.x + 40)
                pts[0][1] = T;
            else
                pts.push([L, B], [L, T]);
            if (R >= g.x + g.width - 40) {
                endY = T;
                break;
            }
            pts.push([R, T], [R, B]);
        }
        pts.push([x1, endY]);
        const cum = [0];
        for (let i = 1; i < pts.length; i++)
            cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        return {pts, cum, len: cum[cum.length - 1]};
    }

    _pathPoint(path, s) {
        const {pts, cum} = path;
        let i = 0;
        if (s <= 0)
            i = 0;
        else if (s >= path.len)
            i = pts.length - 2;
        else
            while (i < pts.length - 2 && cum[i + 1] < s)
                i++;
        const segLen = (cum[i + 1] - cum[i]) || 1;
        const t = (s - cum[i]) / segLen;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }

    // локальні координати машинки -> координати екрана
    _plowToWorld(p, lx, ly) {
        const x = lx * p.dir, c = Math.cos(p.angle), sn = Math.sin(p.angle);
        return [p.px + x * c - ly * sn, p.py + x * sn + ly * c];
    }

    _updatePlow(g, dt) {
        const p = g.plow;
        if (!p.active) {
            p.next -= dt;
            if (p.next > 0)
                return;
            let avg = 0;
            for (let i = 0; i < g.h.length; i++)
                avg += g.h[i];
            avg /= g.h.length || 1;
            if (this._forcePlow || (this._cfg.plow && avg > 2.5)) {
                p.active = true;
                p.dir = Math.random() < 0.5 ? 1 : -1;
                p.s = p.dir > 0 ? 0 : this._plowPath(g).len;
                p.pile = 0;
            } else {
                p.next = 5;
            }
            return;
        }

        const path = this._plowPath(g);
        const onWall = Math.abs(Math.sin(p.angle ?? 0)) > 0.5;
        p.s = Math.max(-2, Math.min(path.len + 2, p.s)) + p.dir * PLOW_SPEED * (onWall ? 2 : 1) * dt;
        p.wheel += PLOW_SPEED * dt / 9;
        p.beacon += dt;
        [p.px, p.py] = this._pathPoint(path, p.s);
        const a = this._pathPoint(path, p.s - 14), b = this._pathPoint(path, p.s + 14);
        p.angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const flat = Math.abs(Math.sin(p.angle)) < 0.15;
        const B = g.y + g.height;

        if (flat) {
            // яку поверхню чистимо: низ екрана чи верх дока
            let h = null, x0 = 0;
            if (Math.abs(p.py - B) < 2) {
                h = g.h;
                x0 = g.x;
            } else {
                const dock = this._windows.find(w => w.isDock && Math.abs(w.rect.y - p.py) < 3 &&
                    p.px >= w.rect.x - 60 && p.px <= w.rect.x + w.rect.width + 60);
                if (dock) {
                    h = dock.cap.h;
                    x0 = dock.rect.x;
                }
            }
            if (h) {
                const lo = p.dir > 0 ? p.px - 46 : p.px - 56;
                const hi = p.dir > 0 ? p.px + 56 : p.px + 46;
                const i0 = Math.max(0, Math.floor((lo - x0) / COLW));
                const i1 = Math.min(h.length - 1, Math.ceil((hi - x0) / COLW));
                let removed = 0;
                for (let i = i0; i <= i1; i++) {
                    if (h[i] > 1) {
                        removed += h[i] - 1;
                        h[i] = 1;
                    }
                }
                p.pile = Math.min(400, p.pile * 0.992 + removed * 0.05);
                if (removed > 0.4) {
                    const count = Math.min(4, 1 + Math.floor(removed / 6));
                    for (let c = 0; c < count; c++) {
                        this._emit(p.px + p.dir * 56, p.py - 14 - Math.random() * 10,
                            p.dir * (60 + Math.random() * 160), -(90 + Math.random() * 150), 2, true);
                    }
                }
            }
        } else if (p.pile > 1) {
            // на стінці купа снігу з відвалу падає вниз
            const [wx, wy] = this._plowToWorld(p, 60, -10);
            this._dropSnow(wx, wy, Math.min(14, p.pile), 0);
            p.pile = 0;
        }

        // дим з вихлопної труби
        p.smoke -= dt;
        if (p.smoke <= 0 && this._puffs.length < 700) {
            p.smoke = 0.18;
            const [sx, sy] = this._plowToWorld(p, -8, -58);
            this._puffs.push({
                x: sx, y: sy,
                vx: (Math.random() - 0.5) * 20, vy: -25 - Math.random() * 15,
                r: 2.5, life: 1, smoke: true,
            });
        }

        if ((p.dir > 0 && p.s >= path.len) || (p.dir < 0 && p.s <= 0)) {
            p.active = false;
            p.pile = 0;
            p.next = this._cfg.plowInterval * (0.8 + Math.random() * 0.4);
        }
    }

    // ---------- малювання ----------
    // маленька машинка, що їздить по верху віджетів (і дока, якщо він не внизу екрана)
    _updateCapPlows(dt) {
        this._capPlows = [];
        for (const w of this._windows) {
            const isWidget = typeof w.key === 'string' && w.key.startsWith('wg');
            const dockAlone = w.isDock && !this._grounds.some(g => g.obs?.includes(w.rect));
            if (!isWidget && !dockAlone)
                continue;
            const cap = w.cap, R = w.rect;
            // на віджетах машинка приїжджає рідко: лише коли снігу вже майже повно
            const rare = () => Math.max(180, this._cfg.plowInterval * 5) * (0.8 + Math.random() * 0.6);
            const p = cap.plow ??= {active: false, next: rare(), dir: 1, s: 0,
                wheel: 0, beacon: 0, angle: 0, px: 0, py: 0, alpha: 0, pile: 0, mini: true};
            p.scale = Math.max(0.35, Math.min(0.6, R.width / 700));
            const carLen = 100 * p.scale;
            const blocked = w.covered.some(v => v);
            if (!p.active) {
                p.next -= dt;
                if (p.next > 0)
                    continue;
                let fill = 0, room = 0;
                for (let i = 0; i < cap.h.length; i++) {
                    fill += cap.h[i];
                    room += cap.c[i];
                }
                if (!blocked && R.width > carLen * 1.6 &&
                    (this._forcePlow || (this._cfg.plow && room > 1 && fill > room * 0.85))) {
                    p.active = true;
                    p.dir = Math.random() < 0.5 ? 1 : -1;
                    p.s = p.dir > 0 ? -carLen * 0.5 : R.width + carLen * 0.5;
                } else {
                    p.next = 10;
                }
                continue;
            }
            if (blocked) {
                p.active = false;
                p.next = 5;
                continue;
            }
            const speed = 75;
            p.s += p.dir * speed * dt;
            p.wheel += speed * dt / (9 * p.scale);
            p.beacon += dt;
            const n = cap.h.length;
            const surf = xx => {
                const ci = Math.max(0, Math.min(n - 1, Math.floor(xx / COLW)));
                return R.y + cap.off[ci];
            };
            const d = 14 * p.scale;
            p.px = R.x + p.s;
            p.py = surf(p.s);
            p.angle = Math.atan2(surf(p.s + d) - surf(p.s - d), 2 * d);
            const inside = Math.min(p.s, R.width - p.s);
            p.alpha = Math.max(0, Math.min(1, (inside + carLen * 0.5) / (carLen * 0.6)));

            // розчищаємо під машинкою
            const lo = p.s - (p.dir > 0 ? 46 : 56) * p.scale;
            const hi = p.s + (p.dir > 0 ? 56 : 46) * p.scale;
            const i0 = Math.max(0, Math.floor(lo / COLW)), i1 = Math.min(n - 1, Math.ceil(hi / COLW));
            let removed = 0;
            for (let i = i0; i <= i1; i++) {
                if (cap.h[i] > 0.6) {
                    removed += cap.h[i] - 0.6;
                    cap.h[i] = 0.6;
                }
            }
            if (removed > 0.4 && Math.random() < 0.7) {
                this._emit(p.px + p.dir * 56 * p.scale, p.py - 10 * p.scale,
                    p.dir * (40 + Math.random() * 110), -(60 + Math.random() * 90), 1.5, true);
            }
            if ((p.dir > 0 && p.s > R.width + carLen * 0.5) || (p.dir < 0 && p.s < -carLen * 0.5)) {
                p.active = false;
                p.next = rare();
                continue;
            }
            this._capPlows.push(p);
        }
    }

    // ---------- огляд (Super) ----------
    _overviewTargets() {
        const targets = new Map();
        const monitor = Main.layoutManager.primaryMonitor;
        const primary = Main.layoutManager.primaryIndex;
        const controls = Main.overview._overview?.controls;
        if (!monitor || !controls)
            return targets;
        const view = controls._workspacesDisplay?._workspacesViews?.[primary];
        for (const ws of view?._workspaces ?? []) {
            const container = ws._background?._backgroundGroup;
            if (ws.monitorIndex === primary && container)
                targets.set(container, {fill: true});
        }
        for (const th of controls._thumbnailsBox?._thumbnails ?? []) {
            const container = th._contents;
            if (th.monitorIndex === primary && container)
                targets.set(container, {fill: false, x: monitor.x, y: monitor.y, w: monitor.width, h: monitor.height});
        }
        return targets;
    }

    _syncOverviewClones() {
        let targets;
        try {
            targets = this._overviewTargets();
        } catch (e) {
            console.debug(`Snowcast: overview targets: ${e}`);
            return;
        }
        for (const [container, clone] of [...this._ovClones]) {
            if (!targets.has(container)) {
                clone.destroy();
                this._ovClones.delete(container);
            }
        }
        for (const [container, t] of targets) {
            let clone = this._ovClones.get(container);
            if (!clone) {
                clone = new Clutter.Clone({
                    source: this._bgArea, reactive: false,
                    x_expand: t.fill, y_expand: t.fill,
                    x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
                });
                container.add_child(clone);
                clone.connect('destroy', () => {
                    if (this._ovClones.get(container) === clone)
                        this._ovClones.delete(container);
                });
                this._ovClones.set(container, clone);
            }
            if (t.fill) {
                clone.set_size(0, 0);
            } else {
                clone.set_position(t.x, t.y);
                clone.set_size(t.w, t.h);
            }
            // сніг — над шпалерами й віджетами
            container.set_child_above_sibling(clone, null);
        }
        this._bgArea.queue_repaint();
    }

    // Сніг на мініатюрах вікон в огляді: до кожної мініатюри (WindowPreview) кріпимо
    // смужку, яка малює сніг цього вікна в масштабі мініатюри.
    _syncPreviewSnow() {
        this._previewAreas ??= new Map();
        if (!this._cfg.windowSnow) {
            this._clearPreviewSnow();
            return;
        }
        const seen = new Set();
        try {
            const views = Main.overview._overview?.controls?._workspacesDisplay?._workspacesViews ?? [];
            for (const view of views) {
                for (const ws of view?._workspaces ?? []) {
                    for (const preview of ws?._windows ?? []) {
                        seen.add(preview);
                        let area = this._previewAreas.get(preview);
                        if (!area) {
                            area = this._addPreviewSnow(preview);
                            if (!area)
                                continue;
                        }
                        area.queue_repaint();
                    }
                }
            }
        } catch (e) {
            console.debug(`Snowcast: overview previews: ${e}`);
        }
        for (const [preview, area] of [...this._previewAreas]) {
            if (!seen.has(preview))
                area.destroy();
        }
    }

    _addPreviewSnow(preview) {
        const container = preview.windowContainer ?? preview.window_container ?? preview._windowContainer;
        if (!container || !preview.metaWindow)
            return null;
        const area = new St.DrawingArea({reactive: false, height: PREVIEW_BAND});
        area.add_constraint(new Clutter.BindConstraint({source: container, coordinate: Clutter.BindCoordinate.X}));
        area.add_constraint(new Clutter.BindConstraint({source: container, coordinate: Clutter.BindCoordinate.WIDTH}));
        area.add_constraint(new Clutter.BindConstraint({
            source: container, coordinate: Clutter.BindCoordinate.Y, offset: -PREVIEW_BAND,
        }));
        area.connect('repaint', a => this._drawPreviewSnow(a, preview, container));
        area.connect('destroy', () => {
            if (this._previewAreas?.get(preview) === area)
                this._previewAreas.delete(preview);
        });
        preview.add_child(area);
        this._previewAreas.set(preview, area);
        return area;
    }

    _drawPreviewSnow(area, preview, container) {
        const cr = area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        try {
            const w = preview.metaWindow;
            const cap = w ? this._caps.get(w.get_stable_sequence()) : null;
            if (cap?.h && container.width > 0) {
                const frame = w.get_frame_rect();
                const sc = container.width / Math.max(1, frame.width);
                cr.translate(0, PREVIEW_BAND);
                cr.scale(sc, sc);
                this._drawCap(cr, 0, 0, cap.h, null, frame.width, null);
            }
        } catch (e) {
            console.debug(`Snowcast: preview snow: ${e}`);
        }
        cr.$dispose();
    }

    _clearPreviewSnow() {
        if (!this._previewAreas)
            return;
        for (const area of [...this._previewAreas.values()])
            area.destroy();
        this._previewAreas.clear();
    }

    _clearOverviewClones() {
        for (const clone of [...this._ovClones.values()])
            clone.destroy();
        this._ovClones.clear();
    }

    // сцена для огляду: сніжинки, кучугура і сніг на віджетах основного монітора
    _drawOverviewLayer(area) {
        const cr = area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const mi = Main.layoutManager.primaryIndex;
        const g = this._grounds[mi];
        if (g) {
            cr.translate(-g.x, -g.y);
            for (const w of this._windows) {
                if (typeof w.key === 'string' && w.key.startsWith('wg'))
                    this._drawCap(cr, w.rect.x, w.rect.y, w.cap.h, null, w.rect.width, w.cap.off);
            }
            this._drawCap(cr, g.x, g.y + g.height + 1, g.h, null, g.width);
            cr.newPath();
            for (const f of this._flakes) {
                if (f.gi !== mi)
                    continue;
                cr.newSubPath();
                cr.arc(f.x, f.y, f.r, 0, TAU);
            }
            cr.setSourceRGBA(1, 1, 1, 0.92 * (this._flakeAlpha ?? 1));
            cr.fillPreserve();
            cr.setSourceRGBA(0.45, 0.55, 0.68, 0.35 * (this._flakeAlpha ?? 1));
            cr.setLineWidth(0.6);
            cr.stroke();
        }
        cr.$dispose();
    }

    _draw(area) {
        const cr = area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        for (const w of this._windows) {
            if (w.cap.animating) {
                const b = this._bounceShape(w.cap);
                this._drawCap(cr, w.rect.x, w.rect.y, b.h, w.covered, w.rect.width, b.off);
            } else {
                this._drawCap(cr, w.rect.x, w.rect.y, w.cap.h, w.covered, w.rect.width, w.cap.off);
            }
        }
        // Активне вікно стоїть «перед» снігом: усе, що далі (кучугури, сніжинки, грудочки,
        // машинка), не малюємо в його межах. Сніг на його верхньому краї вже намальовано вище.
        const fr = this._focusRect;
        if (fr) {
            cr.save();
            cr.newPath();
            cr.rectangle(0, 0, this._area.width, this._area.height);
            roundRect(cr, fr.x, fr.y, fr.width, fr.height, fr.radius);
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.clip();
            cr.setFillRule(Cairo.FillRule.WINDING);
        }

        for (const g of this._grounds)
            this._drawCap(cr, g.x, g.y + g.height + 1, g.h, null, g.width);

        // тепле світіння навколо курсора, коли він топить сніг
        if (this._heat > 0.02 && this._cfg.cursor) {
            const m = this._mouse;
            const glow = new Cairo.RadialGradient(m.x, m.y, 0, m.x, m.y, 30);
            glow.addColorStopRGBA(0, 1, 0.62, 0.3, 0.22 * this._heat);
            glow.addColorStopRGBA(1, 1, 0.62, 0.3, 0);
            cr.setSource(glow);
            cr.newPath();
            cr.arc(m.x, m.y, 30, 0, TAU);
            cr.fill();
        }

        // сніжинки
        cr.newPath();
        for (const f of this._flakes) {
            cr.newSubPath();
            cr.arc(f.x, f.y, f.r, 0, TAU);
        }
        cr.setSourceRGBA(1, 1, 1, 0.92 * (this._flakeAlpha ?? 1));
        cr.fillPreserve();
        cr.setSourceRGBA(0.45, 0.55, 0.68, 0.35 * (this._flakeAlpha ?? 1));
        cr.setLineWidth(0.6);
        cr.stroke();

        // частинки
        for (const p of this._puffs) {
            cr.newPath();
            if (p.steam) {
                const a = p.life < 0.8 ? p.life / 0.8 : (1 - p.life) * 5;
                cr.arc(p.x, p.y, p.r + (1 - p.life) * 6, 0, TAU);
                cr.setSourceRGBA(0.93, 0.96, 1, 0.42 * a);
                cr.fill();
            } else if (p.smoke) {
                cr.arc(p.x, p.y, p.r + (1 - p.life) * 7, 0, TAU);
                cr.setSourceRGBA(0.5, 0.5, 0.52, p.life * 0.3);
                cr.fill();
            } else {
                cr.arc(p.x, p.y, p.r, 0, TAU);
                cr.setSourceRGBA(1, 1, 1, Math.min(1, p.life * 1.4));
                cr.fill();
            }
        }

        for (const g of this._grounds) {
            if (g.plow.active)
                this._drawPlow(cr, g.plow);
        }
        for (const p of this._capPlows ?? []) {
            if (p.alpha < 0.02)
                continue;
            if (p.alpha < 0.99) {
                cr.pushGroup();
                this._drawPlow(cr, p);
                cr.popGroupToSource();
                cr.paintWithAlpha(p.alpha);
            } else {
                this._drawPlow(cr, p);
            }
        }
        if (fr)
            cr.restore();
        cr.$dispose();
    }

    // плавний контур гірки (Catmull-Rom → криві Безьє)
    _drawCap(cr, x0, base, h, covered, width, off = null) {
        const o = k => (off ? off[k] : 0);
        const n = h.length;
        const xEnd = x0 + width;
        let maxH = 2;
        const runs = [];
        let i = 0;
        while (i < n) {
            while (i < n && (h[i] < 0.3 || (covered && covered[i])))
                i++;
            if (i >= n)
                break;
            let j = i;
            while (j < n && h[j] >= 0.3 && !(covered && covered[j]))
                j++;
            const xs = x0 + i * COLW, xe = Math.min(xEnd, x0 + j * COLW);
            const pts = [[xs, base + o(i) - h[i] * 0.35]];
            for (let k = i; k < j; k += 2) {
                pts.push([Math.min(xEnd, x0 + k * COLW + COLW / 2), base + o(k) - h[k]]);
                if (h[k] > maxH)
                    maxH = h[k];
            }
            pts.push([xe, base + o(j - 1) - h[j - 1] * 0.35]);
            runs.push({i, j, xs, xe, pts});
            i = j;
        }
        if (!runs.length)
            return;

        const contour = r => {
            const pts = r.pts;
            cr.lineTo(pts[0][0], pts[0][1]);
            for (let k = 0; k < pts.length - 1; k++) {
                const p0 = pts[k - 1] ?? pts[k], p1 = pts[k], p2 = pts[k + 1], p3 = pts[k + 2] ?? p2;
                cr.curveTo(
                    p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
                    p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
                    p2[0], p2[1]);
            }
        };

        // заливка: низ снігу на 1 px заходить на край, щоб між снігом і поверхнею не було щілини
        cr.newPath();
        for (const r of runs) {
            cr.moveTo(r.xs, base + o(r.i) + 1);
            contour(r);
            cr.lineTo(r.xe, base + o(r.j - 1) + 1);
            if (off) {
                for (let k = r.j - 1; k >= r.i; k -= 2)
                    cr.lineTo(Math.min(xEnd, x0 + k * COLW + COLW / 2), base + o(k) + 1);
            }
            cr.closePath();
        }
        const grad = new Cairo.LinearGradient(0, base - maxH, 0, base);
        grad.addColorStopRGBA(0, 1, 1, 1, 1);
        grad.addColorStopRGBA(0.7, 0.97, 0.98, 1, 1);
        grad.addColorStopRGBA(1, 0.88, 0.92, 0.98, 1);
        cr.setSource(grad);
        cr.fill();

        // обвідка лише по верхньому контуру — без лінії вздовж краю вікна
        cr.newPath();
        for (const r of runs) {
            cr.moveTo(r.pts[0][0], r.pts[0][1]);
            contour(r);
        }
        cr.setSourceRGBA(0.55, 0.63, 0.74, 0.45);
        cr.setLineWidth(1);
        cr.stroke();
    }

    _drawPlow(cr, p) {
        cr.save();
        cr.translate(p.px, p.py);
        cr.rotate(p.angle);
        const sc = p.scale ?? 1;
        cr.scale(p.dir * sc, sc);

        // світло фар
        const beam = new Cairo.LinearGradient(46, 0, 150, 0);
        beam.addColorStopRGBA(0, 1, 0.95, 0.7, 0.35);
        beam.addColorStopRGBA(1, 1, 0.95, 0.7, 0);
        cr.setSource(beam);
        cr.newPath();
        cr.moveTo(34, -26);
        cr.lineTo(150, -44);
        cr.lineTo(150, -2);
        cr.closePath();
        cr.fill();

        // тінь
        cr.newPath();
        ellipse(cr, 2, -1, 54, 4);
        cr.setSourceRGBA(0, 0, 0, 0.2);
        cr.fill();

        // рама
        cr.newPath();
        roundRect(cr, -46, -19, 86, 8, 2);
        hex(cr, '#2d3436');
        cr.fill();

        // кузов з піском
        cr.newPath();
        roundRect(cr, -48, -42, 47, 25, 4);
        hex(cr, '#e67e22');
        cr.fill();
        cr.newPath();
        cr.rectangle(-48, -26, 47, 4);
        hex(cr, '#c0561a');
        cr.fill();
        // сніжок на кузові
        cr.newPath();
        roundRect(cr, -49, -45, 49, 5, 2.5);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.fill();

        // вихлопна труба
        cr.newPath();
        cr.rectangle(-9, -54, 3, 13);
        hex(cr, '#636e72');
        cr.fill();

        // кабіна
        cr.newPath();
        roundRect(cr, 0, -48, 31, 34, 5);
        hex(cr, '#f1c40f');
        cr.fill();
        cr.newPath();
        roundRect(cr, 6, -44, 20, 13, 3);
        hex(cr, '#bfe6ff');
        cr.fill();
        cr.newPath();
        cr.moveTo(10, -33);
        cr.lineTo(16, -43);
        cr.setSourceRGBA(1, 1, 1, 0.7);
        cr.setLineWidth(1.5);
        cr.stroke();
        // сніжок на даху
        cr.newPath();
        roundRect(cr, -1, -51, 33, 5, 2.5);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.fill();

        // мигалка
        const on = Math.sin(p.beacon * 9) > 0;
        if (on) {
            const glow = new Cairo.RadialGradient(15, -54, 0, 15, -54, 18);
            glow.addColorStopRGBA(0, 1, 0.62, 0.1, 0.55);
            glow.addColorStopRGBA(1, 1, 0.62, 0.1, 0);
            cr.setSource(glow);
            cr.newPath();
            cr.arc(15, -54, 18, 0, TAU);
            cr.fill();
        }
        cr.newPath();
        roundRect(cr, 10, -57, 10, 6, 2);
        hex(cr, on ? '#ff9f1a' : '#a8401c');
        cr.fill();

        // фара
        cr.newPath();
        roundRect(cr, 29, -27, 5, 5, 1.5);
        hex(cr, '#fff6c8');
        cr.fill();

        // купа снігу перед відвалом
        if (p.pile > 0.5) {
            const pr = Math.min(20, 3 + Math.sqrt(p.pile) * 1.6);
            cr.newPath();
            ellipse(cr, 50 + pr * 0.7, -pr * 0.45, pr, pr * 0.6);
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.fillPreserve();
            cr.setSourceRGBA(0.55, 0.63, 0.74, 0.6);
            cr.setLineWidth(1);
            cr.stroke();
        }

        // кронштейн і відвал
        cr.newPath();
        cr.rectangle(30, -18, 10, 4);
        hex(cr, '#636e72');
        cr.fill();
        cr.newPath();
        cr.moveTo(38, -31);
        cr.curveTo(50, -28, 56, -16, 54, -1);
        cr.lineTo(41, -1);
        cr.curveTo(45, -14, 43, -24, 38, -31);
        cr.closePath();
        hex(cr, '#b2bec3');
        cr.fillPreserve();
        hex(cr, '#636e72');
        cr.setLineWidth(1.2);
        cr.stroke();
        // помаранчевий край відвалу
        cr.newPath();
        cr.moveTo(42, -1);
        cr.lineTo(54, -1);
        hex(cr, '#e67e22');
        cr.setLineWidth(2.5);
        cr.stroke();

        // колеса
        for (const wx of [-28, 16]) {
            cr.newPath();
            cr.arc(wx, -9, 9, 0, TAU);
            hex(cr, '#2d3436');
            cr.fill();
            cr.newPath();
            cr.arc(wx, -9, 4, 0, TAU);
            hex(cr, '#b2bec3');
            cr.fill();
            cr.setLineWidth(1.4);
            hex(cr, '#636e72');
            for (let s = 0; s < 3; s++) {
                const ang = p.wheel + s * TAU / 3;
                cr.newPath();
                cr.moveTo(wx + Math.cos(ang) * 4, -9 + Math.sin(ang) * 4);
                cr.lineTo(wx + Math.cos(ang) * 8, -9 + Math.sin(ang) * 8);
                cr.stroke();
            }
        }
        cr.restore();
    }
}

// ---------- вікно «Напрямок снігу» ----------
const PW = 320, PH = 200;
const ANGLE_MAX = 75;

function describeAngle(a) {
    if (a === 0)
        return _('↓  Straight down');
    return a < 0
        ? _('↙  %d° to the left').replace('%d', String(-a))
        : _('↘  %d° to the right').replace('%d', String(a));
}

const WindDialog = GObject.registerClass(
class WindDialog extends ModalDialog.ModalDialog {
    _init(settings) {
        super._init({destroyOnClose: true});
        this._settings = settings;
        this._time = 0;
        this._last = 0;
        this._flakes = Array.from({length: 80}, () => ({
            x: Math.random() * PW, y: Math.random() * PH,
            r: 0.8 + Math.random() * 1.8, v: 35 + Math.random() * 45, ph: Math.random() * TAU,
        }));

        const box = this.contentLayout;
        box.add_child(new St.Label({
            text: _('Snow direction'), x_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; font-size: 15pt; margin-bottom: 2px;',
        }));
        box.add_child(new St.Label({
            text: _('Drag the arrow with the mouse or move the slider'), x_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 10pt; color: #9aa4b1; margin-bottom: 10px;',
        }));

        this._area = new St.DrawingArea({width: PW, height: PH, reactive: true, x_align: Clutter.ActorAlign.CENTER});
        this._area.connect('repaint', a => this._draw(a));
        this._area.connect('button-press-event', (_a, e) => {
            this._dragging = true;
            this._fromEvent(e);
            return Clutter.EVENT_STOP;
        });
        this._area.connect('motion-event', (_a, e) => {
            if (this._dragging)
                this._fromEvent(e);
            return Clutter.EVENT_STOP;
        });
        this._area.connect('button-release-event', () => {
            this._dragging = false;
            return Clutter.EVENT_STOP;
        });
        this._area.connect('leave-event', () => {
            this._dragging = false;
            return Clutter.EVENT_PROPAGATE;
        });
        box.add_child(this._area);

        this._label = new St.Label({x_align: Clutter.ActorAlign.CENTER, style: 'font-size: 12pt; margin-top: 10px;'});
        box.add_child(this._label);

        this._slider = new Slider.Slider(0.5);
        this._slider.set_width(PW);
        this._slider.x_align = Clutter.ActorAlign.CENTER;
        this._slider.style = 'margin-top: 6px;';
        this._slider.accessible_name = _('Snow angle');
        this._slider.connect('notify::value', () => {
            if (!this._syncing)
                this._setAngle(Math.round(this._slider.value * 2 * ANGLE_MAX - ANGLE_MAX));
        });
        box.add_child(this._slider);

        this._gusts = new St.Button({
            style_class: 'button', toggle_mode: true, can_focus: true,
            x_align: Clutter.ActorAlign.CENTER, style: 'margin-top: 12px; padding: 6px 16px;',
        });
        this._gusts.connect('notify::checked', () => {
            if (!this._syncing)
                this._settings.set_boolean('wind-gusts', this._gusts.checked);
        });
        box.add_child(this._gusts);

        this.setButtons([
            {label: _('No wind'), action: () => this._setAngle(0)},
            {label: _('Done'), action: () => this.close(), default: true},
        ]);

        this._settingsId = settings.connect('changed', () => this._sync());
        this._sync();

        this._timeline = new Clutter.Timeline({actor: this._area, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
        this.connect('destroy', () => {
            this._timeline?.stop();
            this._timeline = null;
            this._settings.disconnect(this._settingsId);
        });
    }

    _angle() {
        return this._settings.get_int('wind-angle');
    }

    _setAngle(a) {
        a = Math.max(-ANGLE_MAX, Math.min(ANGLE_MAX, Math.round(a)));
        // невелике «прилипання» до вертикалі
        if (Math.abs(a) <= 2)
            a = 0;
        if (a !== this._angle())
            this._settings.set_int('wind-angle', a);
    }

    _sync() {
        const a = this._angle();
        this._syncing = true;
        this._slider.value = (a + ANGLE_MAX) / (2 * ANGLE_MAX);
        const g = this._settings.get_boolean('wind-gusts');
        this._gusts.checked = g;
        this._gusts.label = g ? _('🌬  Wind gusts: on') : _('🌬  Wind gusts: off');
        this._syncing = false;
        this._label.text = describeAngle(a);
        this._area.queue_repaint();
    }

    // стрілка: від центру прев'ю до курсора
    _fromEvent(e) {
        const [ex, ey] = e.get_coords();
        const [ax, ay] = this._area.get_transformed_position();
        const dx = ex - ax - PW / 2, dy = ey - ay - PH / 2;
        if (Math.hypot(dx, dy) < 8)
            return;
        let a = Math.atan2(dx, Math.max(dy, 0.001)) * 180 / Math.PI;
        if (dy <= 0)
            a = dx < 0 ? -ANGLE_MAX : ANGLE_MAX;
        this._setAngle(a);
    }

    _tick() {
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = this._last ? Math.min(0.05, now - this._last) : 0.016;
        this._last = now;
        this._time += dt;
        const tanA = Math.tan(this._angle() * Math.PI / 180);
        const gust = this._settings.get_boolean('wind-gusts')
            ? Math.sin(this._time * 1.1) * 14 + Math.sin(this._time * 2.3) * 6 : 0;
        for (const f of this._flakes) {
            f.ph += dt * 1.5;
            f.x += (f.v * tanA + gust + Math.sin(f.ph) * 6) * dt;
            f.y += f.v * dt;
            if (f.y > PH + 4) {
                f.y = -4;
                f.x = Math.random() * PW;
            }
            if (f.x < -6)
                f.x += PW + 12;
            else if (f.x > PW + 6)
                f.x -= PW + 12;
        }
        this._area.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        // тло — нічне небо із заокругленими кутами
        roundRect(cr, 0, 0, PW, PH, 14);
        const sky = new Cairo.LinearGradient(0, 0, 0, PH);
        sky.addColorStopRGBA(0, 0.09, 0.13, 0.2, 1);
        sky.addColorStopRGBA(1, 0.17, 0.24, 0.33, 1);
        cr.setSource(sky);
        cr.fillPreserve();
        cr.clip();

        // кучугурка внизу
        cr.newPath();
        cr.moveTo(0, PH);
        for (let x = 0; x <= PW; x += 8)
            cr.lineTo(x, PH - 10 - Math.sin(x * 0.04) * 4 - Math.sin(x * 0.11) * 2);
        cr.lineTo(PW, PH);
        cr.closePath();
        cr.setSourceRGBA(0.94, 0.97, 1, 1);
        cr.fill();

        // сніжинки
        cr.newPath();
        for (const f of this._flakes) {
            cr.newSubPath();
            cr.arc(f.x, f.y, f.r, 0, TAU);
        }
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.fill();

        // стрілка напрямку
        const a = this._angle() * Math.PI / 180;
        const cx = PW / 2, cy = PH / 2, len = 62;
        const ex = cx + Math.sin(a) * len, ey = cy + Math.cos(a) * len;
        const sx = cx - Math.sin(a) * len * 0.55, sy = cy - Math.cos(a) * len * 0.55;
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(5);
        cr.setSourceRGBA(0.55, 0.78, 1, this._dragging ? 1 : 0.85);
        cr.newPath();
        cr.moveTo(sx, sy);
        cr.lineTo(ex, ey);
        cr.stroke();
        const head = 14, spread = 0.5;
        const back = Math.atan2(sy - ey, sx - ex);
        cr.newPath();
        cr.moveTo(ex, ey);
        cr.lineTo(ex + Math.cos(back - spread) * head, ey + Math.sin(back - spread) * head);
        cr.lineTo(ex + Math.cos(back + spread) * head, ey + Math.sin(back + spread) * head);
        cr.closePath();
        cr.fill();
        // «ручка» для перетягування
        cr.newPath();
        cr.arc(ex, ey, 9, 0, TAU);
        cr.setSourceRGBA(0.55, 0.78, 1, 0.25);
        cr.fill();
        cr.$dispose();
    }
});

// ---------- значок на панелі ----------
const SnowIndicator = GObject.registerClass(
class SnowIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Snowcast');
        this._ext = ext;
        const settings = ext.getSettings();
        this._settings = settings;
        this._icon = new St.Icon({icon_name: 'weather-snow-symbolic', style_class: 'system-status-icon'});
        this.add_child(this._icon);

        const addSwitch = (label, key) => {
            const item = new PopupMenu.PopupSwitchMenuItem(label, settings.get_boolean(key));
            item.connect('toggled', (_i, state) => settings.set_boolean(key, state));
            const id = settings.connect(`changed::${key}`, () => item.setToggleState(settings.get_boolean(key)));
            item.connect('destroy', () => settings.disconnect(id));
            this.menu.addMenuItem(item);
            return item;
        };

        // головний перемикач: вимикає все, але саме розширення лишається увімкненим
        const master = addSwitch('Snowcast', 'enabled');
        master.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._dependent = [];
        if (settings.settings_schema.has_key('snowfall'))
            this._dependent.push(addSwitch(_('Snowfall'), 'snowfall'));
        this._dependent.push(addSwitch(_('Snow on windows'), 'window-snow'));
        this._dependent.push(addSwitch(_('Snowplow'), 'plow-enabled'));
        this._dependent.push(addSwitch(_('Melt snow with the cursor'), 'cursor-clear'));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._dependent.push(this.menu.addAction(_('🚜  Call the snowplow'), () => ext.engine?.callPlow()));
        this._dependent.push(this.menu.addAction(_('🧹  Clear all snow'), () => ext.engine?.clearAll()));
        this.menu.addAction(_('🌬  Snow direction…'), () => ext.openWindDialog());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Settings…'), () => ext.openPreferences());

        const enabledId = settings.connect('changed::enabled', () => this._syncEnabled());
        this.connect('destroy', () => settings.disconnect(enabledId));
        this._syncEnabled();
    }

    _syncEnabled() {
        const on = this._settings.get_boolean('enabled');
        this._icon.opacity = on ? 255 : 110;
        for (const item of this._dependent)
            item.setSensitive(on);
    }
});

// ---------- розширення ----------
export default class SnowcastExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.engine = null;
        this._indicator = null;
        this._ids = [
            this._settings.connect('changed::enabled', () => this._syncEngine()),
            this._settings.connect('changed::show-indicator', () => this._syncIndicator()),
        ];
        this._syncEngine();
        this._syncIndicator();
        this._updateChecker = this._settings.settings_schema.has_key('check-updates')
            ? new UpdateChecker(this, this._settings) : null;
    }

    openWindDialog() {
        if (!this._settings.settings_schema.has_key('wind-angle')) {
            Main.notify('Snowcast', _('Log out and back in to load the new settings.'));
            return;
        }
        this._windDialog?.close();
        const dialog = new WindDialog(this._settings);
        this._windDialog = dialog;
        dialog.connect('destroy', () => {
            if (this._windDialog === dialog)
                this._windDialog = null;
        });
        dialog.open();
    }

    disable() {
        this._updateChecker?.destroy();
        this._updateChecker = null;
        this._windDialog?.destroy();
        this._windDialog = null;
        for (const id of this._ids)
            this._settings.disconnect(id);
        this._ids = [];
        this.engine?.destroy();
        this.engine = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _syncEngine() {
        const on = this._settings.get_boolean('enabled');
        if (on && !this.engine) {
            this.engine = new SnowEngine(this._settings);
        } else if (!on && this.engine) {
            this.engine.destroy();
            this.engine = null;
        }
    }

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new SnowIndicator(this);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
