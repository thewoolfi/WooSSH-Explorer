# Changelog

All notable changes to WooSSH will be documented in this file.

## [1.3.0] - 2026-10-26

### Added
- **FTP Protocol Support & Stability:**
  - Full FTP/FTPS connection support alongside SFTP/SSH.
  - Protocol switcher in Connection Dialog with automatic default port assignment (21 for FTP, 22 for SFTP).
  - Serialised control command queue to avoid FTP command collisions, and dedicated streaming clients for concurrent file transfers with fast fallback.
  - FTP visual badges on connection cards and saved profiles in the sidebar.
  - Archive creation and extraction support over FTP via streaming readers/writers.
  - Profile persistence fix: `protocol: 'ftp'` saved correctly in configuration store across application restarts.
  - Stream completion synchronization: FTP file writes now reliably await the server's `226 Transfer complete` response before marking uploads done, eliminating premature queue clears and socket collisions.
- **Upload Queue & Batch Progress Tracking:**
  - Pre-upload file evaluation: automatically analyzes and announces total file count and size before transmission starts.
  - Real-time progress display in the Transfer Dock, Transfer View, and Status Bar: shows `X / Y files (remaining: Z) · P%` with progress bar.
  - Client-side concurrency control pool (`runPool`) with `maxConcurrent` transfers to prevent browser socket exhaustion on large directory uploads.
  - Persistent completion notification (*«Все файлы загружены»*) that stays visible until manually dismissed by clicking `✕`.
  - Fixed 401 unauthenticated upload error on desktop Electron by forwarding auth token headers in `api.upload`.
- **Server State Disk Space Separation & Filtering:**
  - Filtered out in-memory and ephemeral pseudo-filesystems (`tmpfs`, `devtmpfs`, `devfs`, `efivarfs`, `ramfs`, `/run/*`, `/sys/*`, `/dev/*`, `/dev/shm`) from the server disks list.
  - Separated disks in Server Status dialog into **Local Disks** (physical OS storage: `/`, `/boot`, `/boot/efi`, `/home`, LVM/RAID) and **Mounted Storages** (`/mnt/*`, `/media/*`, NFS, CIFS/SMB, SSHFS).
  - Status bar disk percentage calculation accounts strictly for local host disks, excluding external mounts and NAS drives.
- **Multi-Selection Size Calculation:**
  - Added button to calculate sizes of multiple selected items at once.
  - Dynamically labeled "Подсчитать размер элемента" for single items and "Подсчитать размеры элементов" for multiple items.
- **Per-Tab Independent Inspector in Split View:**
  - The inspector toggle state is now scoped to individual tabs/panes in split mode.
  - Toggling or closing the inspector on one side no longer affects the other side.
  - Added quick inspector toggle button directly on the file toolbar for each pane.
- **Layout-Independent Hotkeys:**
  - Keyboard shortcuts (`Ctrl+C`, `Ctrl+V`, `Ctrl+X`, `Ctrl+A`, and global hotkeys) now work seamlessly across non-English keyboard layouts (Russian, etc.) by matching physical key codes.

---

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
