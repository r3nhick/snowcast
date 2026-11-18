import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

        const snow = new Adw.PreferencesGroup({title: '❄️ Снігопад'});
        page.add(snow);
        sw(snow, 'enabled', 'Увімкнути снігопад');
        spin(snow, 'intensity', 'Інтенсивність', 'Скільки сніжинок падає одночасно', 5, 100, 5);
        spin(snow, 'max-snow', 'Висота кучугур', 'Максимальна висота снігу внизу екрана, px', 10, 80, 5);
        sw(snow, 'window-snow', 'Сніг на вікнах', 'Сніг налипає на верхні краї вікон');
        if (s.settings_schema.has_key('window-radius'))
            spin(snow, 'window-radius', 'Заокруглення кутів вікон', 'Сніг не лягає на заокруглені кути. Збільште, якщо сніг «висить» над кутом', 0, 40, 1);
        sw(snow, 'shake-off', 'Інерція снігу', 'Сніг ковзає при різкому русі вікна й падає з краю');

        if (s.settings_schema.has_key('wind-angle')) {
            const wind = new Adw.PreferencesGroup({
                title: '🌬 Вітер',
                description: 'Те саме можна задати мишкою: значок сніжинки → «Напрямок снігу…»',
            });
            page.add(wind);
            spin(wind, 'wind-angle', 'Напрямок снігу', 'Кут від вертикалі: мінус — вліво, плюс — вправо', -75, 75, 5);
            sw(wind, 'wind-gusts', 'Пориви вітру', 'Сніг то сильніше, то слабше зносить убік');
        }

        const fun = new Adw.PreferencesGroup({title: '🚜 Прибирання'});
        page.add(fun);
        sw(fun, 'plow-enabled', 'Машинка-снігоприбиральник', 'Час від часу проїжджає внизу екрана');
        spin(fun, 'plow-interval', 'Інтервал машинки', 'Секунд між проїздами', 10, 300, 5);
        sw(fun, 'cursor-clear', 'Топити сніг курсором', 'Курсор розтоплює сніг, над ним піднімається пара');

        const misc = new Adw.PreferencesGroup({title: 'Інше'});
        page.add(misc);
        sw(misc, 'hide-on-fullscreen', 'Ховати в повноекранному режимі', 'Не заважає відео та іграм');
        spin(misc, 'frame-rate', 'Кадрів на секунду', 'Менше — легше для процесора', 15, 60, 5);
        sw(misc, 'show-indicator', 'Значок на верхній панелі');
    }
}
