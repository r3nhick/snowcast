import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SnowcastPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window._settings = s;

        const page = new Adw.PreferencesPage({title: 'Snowcast', icon_name: 'weather-snow-symbolic'});
        window.add(page);

        const sw = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };
        const spin = (group, key, title, subtitle, min, max, step) => {
            const row = Adw.SpinRow.new_with_range(min, max, step);
            row.set_title(title);
            row.set_subtitle(subtitle);
            s.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        const snow = new Adw.PreferencesGroup({title: _('❄️ Snowfall')});
        page.add(snow);
        sw(snow, 'enabled', _('Enable snowfall'));
        spin(snow, 'intensity', _('Intensity'), _('How many snowflakes fall at once'), 5, 100, 5);
        spin(snow, 'max-snow', _('Snowdrift height'), _('Maximum snow height at the bottom of the screen, px'), 10, 80, 5);
        sw(snow, 'window-snow', _('Snow on windows'), _('Snow sticks to the top edges of windows'));
        if (s.settings_schema.has_key('window-radius'))
            spin(snow, 'window-radius', _('Window corner radius'), _('Snow doesn’t settle on rounded corners. Increase it if snow “hangs” over a corner'), 0, 40, 1);
        sw(snow, 'shake-off', _('Snow inertia'), _('Snow slides when a window moves sharply and falls off the edge'));

        if (s.settings_schema.has_key('wind-angle')) {
            const wind = new Adw.PreferencesGroup({
                title: _('🌬 Wind'),
                description: _('You can also set it with the mouse: snowflake icon → “Snow direction…”'),
            });
            page.add(wind);
            spin(wind, 'wind-angle', _('Snow direction'), _('Angle from vertical: minus — left, plus — right'), -75, 75, 5);
            sw(wind, 'wind-gusts', _('Wind gusts'), _('Snow drifts sideways, sometimes stronger, sometimes weaker'));
        }

        const fun = new Adw.PreferencesGroup({title: _('🚜 Clearing')});
        page.add(fun);
        sw(fun, 'plow-enabled', _('Snowplow'), _('Drives along the bottom of the screen from time to time'));
        spin(fun, 'plow-interval', _('Snowplow interval'), _('Seconds between runs'), 10, 300, 5);
        sw(fun, 'cursor-clear', _('Melt snow with the cursor'), _('The cursor melts snow, and steam rises above it'));

        const misc = new Adw.PreferencesGroup({title: _('Other')});
        page.add(misc);
        sw(misc, 'hide-on-fullscreen', _('Hide in fullscreen'), _('Doesn’t get in the way of videos and games'));
        spin(misc, 'frame-rate', _('Frames per second'), _('Lower is easier on the CPU'), 15, 60, 5);
        sw(misc, 'show-indicator', _('Icon in the top bar'));
    }
}
