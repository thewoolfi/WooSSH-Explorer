# Changelog

All notable changes to WooSSH will be documented in this file.

## [1.2.0] - 2026-10-23

### Added
- **Terminal Quick Commands & Maintenance Inspector:**
  - Dedicated inspector panel for the terminal with 10 categorized quick commands (Updates & Packages, Monitoring, Network & Services, System & Logs).
  - Package manager template switcher supporting **APT**, **DNF**, **Pacman**, **APK**, and **Auto (Smart)** detection.
  - One-click command dispatch directly to the remote shell stdin.
  - Command copying with temporary feedback badge.
  - Remote system overview showing hostname, kernel release, and load average.
- **Terminal Mouse Wheel Scrolling:**
  - Intercepted wheel events so scrolling over stdout history smoothly scrolls the viewport instead of sending escape sequences into shell input.
- **Interactive Scrollbar in Terminal:**
  - Full mouse drag and track click support for the terminal scrollbar.
  - Hover highlight and active accent styling on the scrollbar thumb.
- **Prominent Terminal Toolbar Toggle:**
  - Added dedicated `[Inspector]` button in the terminal header with active status indicator.

### Fixed
- Fixed flexbox layout bug where closing the terminal inspector locked the terminal width and prevented the inspector from reopening.
- Fixed layout refitting on panel resize and toggle.

---

## [1.1.1] - 2026-10-19

### Added
- File relay support between local computer and remote SSH hosts.
- Platform-aware local path handling for cross-platform file operations.

---

## [1.1.0] - 2026-10-14

### Added
- **My Computer:** Browse local drives and directories alongside remote SSH hosts from a tab.
- Integrated local file operations, file size formatting, and local folder navigation.

---

## [1.0.3] - 2026-10-13

### Added
- Bounded folder-size calculation.
- Drag-to-select rectangle for file listings.

---

## [1.0.2] - 2026-10-12

### Fixed
- Pinned host key verification and known_hosts entry format handling.
- Connection timeout and retry tuning.

---

## [1.0.1] - 2026-10-10

### Fixed
- Terminal sizing and resize debouncing.
- Archive packing and unpacking path validation.

---

## [1.0.0] - 2026-10-09

### Added
- Initial release of WooSSH Explorer: modern SSH file explorer and terminal application for remote hosts.
- Dual-pane split mode, SFTP transfers with speed limiting, tabbed navigation, and command palette.
