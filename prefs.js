import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const REPO_URL = 'https://github.com/r3nhick/snowcast';
// Not options but internal state: «Reset all settings» leaves these alone.
const INTERNAL_KEYS = new Set(['open-prefs-page', 'update-latest', 'update-url', 'update-checked-at', 'update-shown']);

const fmt = (text, value) => text.replace('%s', value);

/** Whether version `a` ("1.2.0") is newer than `b`, number by number. */
function isNewer(a, b) {
    const parts = v => String(v ?? '').replace(/^v/i, '').split('.').map(p => parseInt(p, 10) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}

export default class SnowcastPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window._settings = s;
        // Handlers that touch the window's widgets are released when it closes.
        this._signals = [];
        this._sources = [];
        window.connect('close-request', () => {
            this._release();
            return false;
        });

        window.add(this._buildSettingsPage(s));
        const about = this._buildAboutPage(s, window);
        window.add(about);

        // Deep link from the «new version» notification.
        if (s.settings_schema.has_key('open-prefs-page')) {
            const open = s.get_string('open-prefs-page');
            if (open) {
                s.set_string('open-prefs-page', '');
                if (open === 'about')
                    window.set_visible_page(about);
            }
        }
    }

    _track(object, id) {
        this._signals.push([object, id]);
    }

    _trackSource(id) {
        this._sources.push(id);
    }

    _release() {
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (_e) {
                // already gone
            }
        }
        this._signals = [];
        const context = GLib.MainContext.default();
        for (const id of this._sources) {
            if (context.find_source_by_id(id))
                GLib.source_remove(id);
        }
        this._sources = [];
    }

    // ── Settings page ─────────────────────────────────────────────────────
    _buildSettingsPage(s) {
        const page = new Adw.PreferencesPage({title: _('Settings'), icon_name: 'weather-snow-symbolic'});

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

        const main = new Adw.PreferencesGroup();
        page.add(main);
        sw(main, 'enabled', _('Enable Snowcast'), _('Turns everything off without disabling the extension'));

        const snow = new Adw.PreferencesGroup({title: _('❄️ Snowfall')});
        page.add(snow);
        if (s.settings_schema.has_key('snowfall'))
            sw(snow, 'snowfall', _('Snowfall'), _('When off, no new snow falls, but the settled snow stays'));
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
        if (s.settings_schema.has_key('hide-over-focused'))
            sw(misc, 'hide-over-focused', _('Hide falling snow over the active window'),
                _('Snow falls behind the window you are working in; the snow on its top edge stays'));
        sw(misc, 'hide-on-fullscreen', _('Hide in fullscreen'), _('Doesn’t get in the way of videos and games'));
        spin(misc, 'frame-rate', _('Frames per second'), _('Lower is easier on the CPU'), 15, 60, 5);
        sw(misc, 'show-indicator', _('Icon in the top bar'));
        return page;
    }

    // ── About page (the same as in Desktop Widgets) ───────────────────────
    _buildAboutPage(s, window) {
        const page = new Adw.PreferencesPage({title: _('About'), icon_name: 'help-about-symbolic'});
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');

        const head = new Adw.PreferencesGroup({margin_top: 12});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 18,
            margin_bottom: 18,
            halign: Gtk.Align.CENTER,
        });
        box.append(new Gtk.Image({icon_name: 'weather-snow-symbolic', pixel_size: 128, margin_bottom: 6}));
        box.append(new Gtk.Label({label: this.metadata.name, css_classes: ['title-1'], wrap: true,
            justify: Gtk.Justification.CENTER}));
        box.append(new Gtk.Label({label: 'r3nhick', css_classes: ['heading'], margin_top: 4}));
        box.append(new Gtk.Label({label: fmt(_('Version %s'), version), css_classes: ['dim-label'], margin_top: 4}));
        const headRow = new Adw.ActionRow({activatable: false});
        headRow.set_child(box);
        head.add(headRow);
        page.add(head);

        const help = new Adw.PreferencesGroup();
        if (s.settings_schema.has_key('check-updates')) {
            for (const row of this._updateRows(s, window, version))
                help.add(row);
        }
        help.add(this._linkRow(_('Website'), REPO_URL, _('Features, installing and updating')));
        help.add(this._linkRow(_('Report a problem'), `${REPO_URL}/issues/new`,
            _('On GitHub; paste the report below in it')));
        const report = new Adw.ActionRow({
            title: _('Copy a bug report'),
            subtitle: _('Versions, system and changed settings, ready to paste into a report'),
            activatable: true,
        });
        report.add_suffix(new Gtk.Image({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER}));
        report.connect('activated', () => this._copyBugReport(s, window, report));
        help.add(report);
        help.add(this._linkRow(_('License'), `${REPO_URL}/blob/main/LICENSE`,
            _('GNU General Public License, version 3 or later')));
        page.add(help);

        const resetGroup = new Adw.PreferencesGroup({title: _('Settings')});
        const resetRow = new Adw.ActionRow({
            title: _('Reset all settings'),
            subtitle: _('Back to the defaults'),
            activatable: true,
        });
        resetRow.connect('activated', () => this._confirmReset(s, window));
        resetGroup.add(resetRow);
        page.add(resetGroup);
        return page;
    }

    _linkRow(title, url, subtitle) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic', valign: Gtk.Align.CENTER}));
        row.set_tooltip_text(url);
        row.connect('activated', () => Gio.AppInfo.launch_default_for_uri_async(url, null, null, null));
        return row;
    }

    _confirmReset(s, window) {
        const heading = _('Reset all settings?');
        const body = _('Every option goes back to its default.');
        const reset = () => {
            for (const key of s.settings_schema.list_keys()) {
                if (!INTERNAL_KEYS.has(key))
                    s.reset(key);
            }
        };
        // Adw.AlertDialog appeared in libadwaita 1.5 (GNOME 46); GNOME 45 has Adw.MessageDialog.
        const dialog = Adw.AlertDialog
            ? new Adw.AlertDialog({heading, body})
            : new Adw.MessageDialog({heading, body, transient_for: window, modal: true});
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', _('Reset'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'reset')
                reset();
        });
        if (Adw.AlertDialog)
            dialog.present(window);
        else
            dialog.present();
    }

    // ── Updates ───────────────────────────────────────────────────────────
    // The status row + the opt-in switch. The shell side (lib/updates.js)
    // asks GitHub once a day and stores what it found in settings; this row
    // follows those keys. A git checkout updates in one click (git pull);
    // otherwise the row links to the download.
    _updateRows(settings, window, version) {
        const dir = this.path;
        const isGit = GLib.file_test(GLib.build_filenamev([dir, '.git']), GLib.FileTest.EXISTS);

        // The version on disk: after an update it is the new one while the
        // shell still runs the old one until the next login.
        const installedVersion = () => {
            try {
                const [, bytes] = Gio.File.new_for_path(GLib.build_filenamev([dir, 'metadata.json'])).load_contents(null);
                return JSON.parse(new TextDecoder().decode(bytes))['version-name'] ?? '';
            } catch (_e) {
                return '';
            }
        };
        const checkedWhen = ms => {
            const then = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
            const now = GLib.DateTime.new_now_local();
            const days = now.get_day_of_year() - then.get_day_of_year() +
                365 * (now.get_year() - then.get_year());
            return days <= 0 ? _('today') : days === 1 ? _('yesterday') : then.format('%e %b').trim();
        };

        // Texts may come from GitHub / git output: never markup.
        const status = new Adw.ActionRow({use_markup: false});
        const icon = new Gtk.Image({valign: Gtk.Align.CENTER});
        const spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER, spinning: true, visible: false});
        status.add_prefix(icon);
        status.add_prefix(spinner);

        const button = (label, css) => new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css, visible: false});
        const download = button(_('Download'), []);
        download.connect('clicked', () => new Gtk.UriLauncher({
            uri: settings.get_string('update-url') || REPO_URL,
        }).launch(window, null, null));
        const update = button(_('Update'), ['suggested-action']);
        const logOut = button(_('Log Out'), ['suggested-action']);
        logOut.connect('clicked', () => {
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', 'Logout', new GLib.Variant('(u)', [0]), null,
                Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
                    try {
                        bus.call_finish(res);
                    } catch (_e) {
                        GLib.spawn_async(null, ['gnome-session-quit', '--logout'], null,
                            GLib.SpawnFlags.SEARCH_PATH, null);
                    }
                });
        });
        const suffixes = [download, update, logOut];
        for (const suffix of suffixes)
            status.add_suffix(suffix);

        const check = new Adw.SwitchRow({
            title: _('Check for new versions'),
            subtitle: _('Asks GitHub once a day; nothing else is sent'),
        });
        settings.bind('check-updates', check, 'active', Gio.SettingsBindFlags.DEFAULT);

        let updating = false;
        let failure = null;
        const show = (iconName, css, title, subtitle, buttons = []) => {
            icon.icon_name = iconName ?? '';
            icon.css_classes = css;
            icon.visible = !updating;
            spinner.visible = updating;
            status.title = title;
            status.subtitle = subtitle;
            for (const suffix of suffixes)
                suffix.visible = buttons.includes(suffix);
        };

        const sync = () => {
            const on = settings.get_boolean('check-updates');
            const latest = settings.get_string('update-latest');
            const checkedAt = Number(settings.get_int64('update-checked-at'));
            const installed = installedVersion();

            if (updating) {
                show(null, [], fmt(_('Updating to Snowcast %s…'), latest), _('Downloading from GitHub'));
            } else if (failure) {
                update.label = _('Try Again');
                show('dialog-warning-symbolic', ['warning'], _('Couldn’t update'), failure, [download, update]);
            } else if (installed && isNewer(installed, version)) {
                show('object-select-symbolic', ['success'], fmt(_('Snowcast %s is installed'), installed),
                    _('Log out and back in to finish'), [logOut]);
            } else if (!on) {
                show('software-update-available-symbolic', ['dim-label'], _('Not checking for new versions'),
                    _('Turn it on below to hear when one is out'));
            } else if (latest && isNewer(latest, version)) {
                update.label = _('Update');
                show('software-update-available-symbolic', ['accent'], fmt(_('Snowcast %s is out'), latest),
                    isGit ? _('Your snow and settings stay') : _('Download it from GitHub'),
                    isGit ? [update] : [download]);
            } else if (checkedAt > 0 && latest) {
                show('object-select-symbolic', ['success'], _('You’re up to date'),
                    fmt(_('Checked %s'), checkedWhen(checkedAt)));
            } else {
                show('software-update-available-symbolic', ['dim-label'], _('Not checked yet'),
                    _('Snowcast asks GitHub once a day'));
            }
        };

        // One-click update for a git checkout: fast-forward only, so local
        // edits are never overwritten (git refuses and says why).
        update.connect('clicked', () => {
            if (updating || !isGit)
                return;
            updating = true;
            failure = null;
            sync();
            const run = (argv, done) => {
                try {
                    const proc = Gio.Subprocess.new(argv,
                        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
                    proc.communicate_utf8_async(null, null, (p, res) => {
                        let out = '';
                        try {
                            [, out] = p.communicate_utf8_finish(res);
                        } catch (e) {
                            out = String(e.message ?? e);
                        }
                        done(p.get_successful(), (out ?? '').trim());
                    });
                } catch (e) {
                    done(false, String(e.message ?? e));
                }
            };
            run(['git', '-C', dir, 'pull', '--ff-only'], (ok, out) => {
                if (!ok) {
                    updating = false;
                    const line = out.split('\n').filter(l => l.trim()).pop() ?? '';
                    failure = /local changes|would be overwritten|uncommitted/i.test(out)
                        ? _('This copy has local changes; git didn’t overwrite them. Commit or stash them, or download instead')
                        : /could not resolve|unable to access|network/i.test(out)
                            ? _('GitHub couldn’t be reached; try again later')
                            : line || _('git pull failed');
                    sync();
                    return;
                }
                if (!isNewer(installedVersion(), version)) {
                    updating = false;
                    failure = /up to date/i.test(out)
                        ? _('This copy already matches GitHub; nothing new was downloaded. Check metadata.json for local edits')
                        : _('git finished, but the version on disk didn’t change');
                    sync();
                    return;
                }
                // New keys may come with the update: compile the schema.
                run(['glib-compile-schemas', GLib.build_filenamev([dir, 'schemas'])], () => {
                    updating = false;
                    sync();
                });
            });
        });

        for (const key of ['check-updates', 'update-latest', 'update-checked-at'])
            this._track(settings, settings.connect(`changed::${key}`, () => sync()));
        sync();
        return [status, check];
    }

    // A plain-text report (versions, system, changed settings, recent errors)
    // put on the clipboard. Nothing personal goes in.
    async _copyBugReport(settings, window, row) {
        const original = row.subtitle;
        const lines = [];
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        lines.push(`Snowcast ${version} (version ${this.metadata.version ?? '?'})`);
        try {
            const Config = await import('resource:///org/gnome/Shell/Extensions/js/misc/config.js');
            lines.push(`GNOME Shell ${Config.PACKAGE_VERSION}`);
        } catch (_e) {
            lines.push('GNOME Shell: unknown');
        }
        try {
            const [, bytes] = Gio.File.new_for_path('/etc/os-release').load_contents(null);
            const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(new TextDecoder().decode(bytes))?.[1];
            if (pretty)
                lines.push(`OS: ${pretty}`);
        } catch (_e) {}
        lines.push(`Session: ${GLib.getenv('XDG_SESSION_TYPE') ?? '?'}, desktop: ${GLib.getenv('XDG_CURRENT_DESKTOP') ?? '?'}`);
        lines.push(`Install: ${GLib.file_test(GLib.build_filenamev([this.path, '.git']), GLib.FileTest.EXISTS) ? 'git checkout' : 'package'}`);

        const changed = settings.settings_schema.list_keys()
            .filter(key => settings.get_user_value(key) !== null && !INTERNAL_KEYS.has(key))
            .sort()
            .map(key => `  ${key} = ${settings.get_value(key).print(false)}`);
        lines.push(changed.length ? `Changed settings:\n${changed.join('\n')}` : 'Changed settings: none');

        // Recent errors of this extension from the user's journal.
        const journal = await new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    ['journalctl', '--user', '-b', '--no-pager', '-o', 'short-monotonic', '-n', '3000'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        resolve(out ?? '');
                    } catch (_e) {
                        resolve('');
                    }
                });
            } catch (_e) {
                resolve('');
            }
        });
        const recent = journal.split('\n')
            .filter(l => /snowcast/i.test(l) && /(error|warn|exception|failed|critical)/i.test(l))
            .slice(-30)
            .map(l => l.split(GLib.get_home_dir()).join('~'));
        lines.push(recent.length ? `Recent errors:\n${recent.join('\n')}` : 'Recent errors: none found');

        window.get_display().get_clipboard().set(lines.join('\n'));
        row.subtitle = _('Copied — paste it into the report on GitHub');
        this._trackSource(GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            row.subtitle = original;
            return GLib.SOURCE_REMOVE;
        }));
    }
}
