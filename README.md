# Snowcast ❄️

A GNOME Shell extension (45–51) that brings snow to your desktop.

![Snowcast on the desktop: snow on a terminal window, desktop widgets and the dock](assets/photo.png)

## Features

- **Snowflakes** fall over your windows, drifting with the wind and gusts. Set the direction with the mouse: snowflake icon → “Snow direction…”.
- **Snow piles up** on the top edges of windows, the dock and desktop widgets. The drifts have hills of different heights, and snow never sits on rounded corners.
- **Snow physics:**
  - shrink a window, and the snow from the cut-off part falls down;
  - move a window sharply, and the snow slides by inertia and falls off the edge;
  - jerk a window down, and the snow bounces softly and wobbles;
  - close or minimize a window, and its snow tumbles onto the windows below.
- **Snowdrifts** gather at the bottom of the screen.
- **A little snowplow** clears the drifts and climbs onto the dock. A smaller one rides along the top of desktop widgets.
- **A warm cursor** melts the snow, and steam rises from it.
- **The overview (Super)** shows the snow too, just like the widgets.
- **A master Snowcast switch** in the menu turns everything off without disabling the extension. **Snowfall** only stops new snow from falling: the settled snow stays.

Works with Dash to Dock, Ubuntu Dock, dash2dock-lite and Desktop Widgets.

## Languages

The interface is available in English, Ukrainian and Turkish. The language follows your system locale.

To add a translation, copy `po/snowcast@r3nhick.pot` to `po/<lang>.po`, translate the strings and compile it:

```
msgfmt po/<lang>.po -o locale/<lang>/LC_MESSAGES/snowcast@r3nhick.mo
```

## Installation

```
git clone https://github.com/r3nhick/snowcast.git ~/.local/share/gnome-shell/extensions/snowcast@r3nhick
glib-compile-schemas ~/.local/share/gnome-shell/extensions/snowcast@r3nhick/schemas
```

Log out and back in, then run:

```
gnome-extensions enable snowcast@r3nhick
```

## Updating

Snowflake icon → “Settings…” → **About**. Turn on **Check for new versions**: once a day Snowcast asks GitHub whether a newer version is out (nothing else is sent) and lets you know with a notification. If you installed Snowcast with `git clone`, the **Update** button there updates it in one click (`git pull`); then log out and back in.

Or update by hand:

```
git -C ~/.local/share/gnome-shell/extensions/snowcast@r3nhick pull
```

## Settings

Snowflake icon in the top bar → “Settings…”, or:

```
gnome-extensions prefs snowcast@r3nhick
```

## License

Snowcast is free software, released under the [GNU General Public License v3.0](LICENSE) or later.
