# Desktop Manual QA

Run against a dev or packaged desktop build after `pnpm --filter @atrium/desktop build`.

1. Launch Atrium Desktop and open a session popout. Confirm the popout uses the same macOS `hiddenInset` traffic-light chrome as the main window.
2. Use the real application menu accelerators: Command+N opens a new window, Command+R reloads, Shift+Command+R force reloads, Command+0 resets zoom, Command+Plus zooms in, Command+- zooms out, and Control+Command+F toggles fullscreen.
3. Launch Atrium Desktop a second time while it is already running. Confirm the existing window is focused and no duplicate app process/window is created.
4. Press Command+W or click the window close control. Confirm Atrium hides to the tray/menu bar instead of quitting, then choose tray/menu-bar "Quit Atrium" and confirm the app exits.
5. Open the same session's popout from two different entry points. Confirm the second action focuses the existing popout instead of creating a duplicate window.
