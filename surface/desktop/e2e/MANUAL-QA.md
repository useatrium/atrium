# Desktop Manual QA

Run against a dev or packaged desktop build after building both the web renderer and shell:

```bash
pnpm --filter @atrium/web build
pnpm --filter @atrium/desktop build
```

Use a disposable profile (`--user-data-dir=/tmp/atrium-desktop-qa-<unique>`) so the run does not read or modify a normal Atrium profile. Remove it after quitting.

## macOS — shipped and supported

1. With macOS Appearance set to Light, launch Atrium from a stopped state. Confirm the initial window is light before the renderer paints—there must be no black flash. Repeat with Appearance set to Dark and confirm the initial window is dark. Switch Appearance while Atrium is open, open a new window, and confirm its launch background follows the new system appearance.
2. Confirm the main window and a session popout use native inset traffic-light chrome. Controls must remain usable at normal and compact widths; no custom title bar should appear.
3. Resize the main window and a popout to their minimum `420 × 480` window size. Confirm the renderer switches to its compact layout without horizontal clipping of required controls. Also check the default `1280 × 832` main window.
4. Use the application menu accelerators: Command+N opens a new window, Command+R reloads, Shift+Command+R force reloads, Command+0 resets zoom, Command+Plus zooms in, Command+- zooms out, and Control+Command+F toggles fullscreen.
5. In View, test zoom at 80%, 125%, and 200%. Confirm menus remain native, required renderer controls remain reachable, text is not clipped, and Command+0 returns to 100%.
6. Use Go > Home, Files, Agents, Inbox, and Settings. Confirm the existing focused main window comes forward and navigates to the selected destination. Repeat once while a popout has focus; navigation must target a main window.
7. Launch Atrium a second time while it is already running. Confirm the existing window is restored/focused and no duplicate app process/window is created. Repeat with a supported `atrium://` deep link and confirm it navigates the existing main window.
8. Press Command+W or click the window close control. Confirm Atrium hides to the menu bar instead of quitting, then choose menu-bar “Quit Atrium” and confirm the app exits.
9. Open the same session popout from two different entry points. Confirm the second action focuses the existing popout instead of creating a duplicate. Close it, use Window > Reopen Closed Window, and confirm it reopens once.
10. Verify external HTTP(S) links open in the default browser, while unsupported internal window requests do not create an untrusted Electron window. Confirm microphone/camera permission behavior still supports calls.
11. Inspect screenshots at compact and default sizes in both appearances. Record the account state, OS version, display scale, zoom, and whether the build is dev, signed, or packaged.

## Windows and Linux — implemented code paths, not shipped/verified

Atrium currently has a macOS packaging target only. Windows and Linux keep Electron’s standard native title bar and the same `420 × 480` floor, menus, shortcuts, theme-derived launch background, tray behavior, and popout policy in source, but release parity is not claimed until packaged builds are added and exercised on those operating systems.

When platform builds become available, run the macOS matrix above with these substitutions:

- Use Control for menu shortcuts and the platform fullscreen convention shown by the native View menu.
- Confirm standard system title bars remain visible on main and popout windows; popouts should auto-hide their menu bar where Electron supports it.
- Confirm close-to-tray, tray restore, taskbar/dock badges, second-instance focus, deep links, external links, and 80/125/200% zoom using the target desktop environment.
- On Windows, verify light/dark launch behavior in Windows Settings and test at 100%, 125%, and 200% display scaling.
- On Linux, record the distribution, desktop environment, display server (X11/Wayland), theme, and whether tray/status-notifier support is present. Mark environment-specific failures rather than implying universal Linux support.
