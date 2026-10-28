# LimitTrack v1.2.2

Fixes the desktop widget covering other applications.

- Removed always-on-top behavior and focus stealing when the widget opens.
- On Windows, the widget appears when the desktop or widget is active and hides when you switch to an application. Return to the desktop to see it again.
- macOS and Linux use the platform desktop window type; behavior depends on the desktop/window manager.
- Removed the request to show the widget over full-screen spaces.
- Windows desktop detection uses a small bundled native helper built from source. No PowerShell execution-policy changes or shell modifications are required.
- If desktop detection is unavailable, the widget stays hidden and Widgets shows a retry message. Tool selection and visibility preferences are preserved.

All appearance, account, backup, and reset-tracking features from v1.2.1 remain available. Automated checks cover window configuration, desktop/app transitions, off-switch behavior, detection failure, retry, and observer cleanup. The helper is compiled and smoke-tested during the Windows build; native visual verification remains a separate platform check.

Windows: use the Setup executable to install, or the other executable for the portable app. macOS: use the DMG. Linux: use the AppImage or DEB. Installers are unsigned.
