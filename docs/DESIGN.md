# WooSSH Explorer — visual QA ledger

The accepted concept set lives in [`design/concepts/`](../design/concepts). The
implementation screenshots in `design/qa/` are produced by
`npm run qa` (`tools/qa/run-qa.mjs`), which drives a real Chromium against the real
server and a real SSH server (`server/test/support/mockSshServer.ts`).

## Accepted concepts and what each one governs

| concept | governs |
| --- | --- |
| `concept-a-main-explorer.png` | three-pane shell, selected-row treatment (mint tint + 2px left bar), status bar, breadcrumb + search + view-toggle toolbar |
| `concept-a-main-explorer-v2.png` | sidebar host rows with colour dots, active row filled with the accent, uppercase letterspaced column headers, monospace metadata columns |
| `concept-b-terminal-transfers.png` | transfer-row anatomy (icon, name, right-aligned speed, thin progress bar), terminal inset with prompt/output contrast |
| `concept-c-connection-dialogs.png` | modal anatomy, segmented auth control, primary mint action, host-key fingerprint block with an amber warning |
| `concept-d-light-theme.png` | light palette: white canvas, `#F7F8F9` sidebar, pale-mint selection, mint-filled active host row |
| `concept-e-file-pane-detail.png` | file-pane density: 30px rows, hairline separators, thin outline folder icons, 2px accent bar on the selected row |

## Extraction: concept → tokens

Read off the concept renders and implemented in `web/src/styles/tokens.css`:

| token | dark | light | source |
| --- | --- | --- | --- |
| page / sidebar | `#0A0C10` | `#F7F8F9` | concept-a / concept-d |
| panel surface | `#101419` | `#FFFFFF` | concept-a / concept-d |
| hover surface | `#151A21` | `#F1F3F5` | concept-a-v2 rows |
| terminal / preview inset | `#07090C` | `#F6F7F9` | concept-b |
| hairline | `rgba(255,255,255,.07)` | `#E6E8EB` | concept-e |
| body text | `#E6EAF0` | `#14181D` | concept-a / concept-d |
| muted text | `#8A93A0` | `#6B7480` | concept-a |
| accent | `#5EE6C4` | `#12B886` | all concepts |
| host tags | amber / violet / sky / rose / slate | idem | concept-a-v2 sidebar |

Type scale: 10 / 11 / 12 / 13 / 15 / 17 / 20 px with a 0.09em uppercase tracking for
micro labels; monospace (Cascadia/JetBrains/Consolas stack) for paths, sizes,
permissions, terminal and every numeral column. Row height 30px, sidebar row 44px,
tab strip 36px, toolbar 44px, status bar 28px, sidebar 252px, inspector 292px.

Icons: a hand-built 16px outline set (`web/src/components/ui/Icon.tsx`), 1.35–1.4px
optical stroke, round caps and joins, `currentColor` — matching the thin outline
folder/file glyphs and hairline chrome icons in the concepts rather than a generic
icon pack.

## Deliberate reconciliations between concepts

1. **Selected row.** `concept-e` shows a heavily saturated mint row; `concept-a` and
   `concept-d` show a restrained tint. A dense table cannot carry a fully saturated
   row on every selection, so the implementation uses `concept-a`'s tint
   (`accent @ 14%`) plus `concept-e`'s 2px accent left bar and brighter white name.
2. **Dialogs.** `concept-c` lays fields out label-left / value-right. The
   implementation keeps the concept's boxes, segmented control, fingerprint block and
   footer but stacks labels above inputs, because long values (key paths, fingerprints)
   are unreadable in a right-aligned value column.
3. **Transfer dock.** `concept-b` floats a macOS-like window over the app. That window
   chrome belongs to the mockup, not to the product, so the queue is implemented as a
   resizable dock inside the app shell, keeping the row anatomy and progress bars.
4. **Inspector with nothing selected.** The concepts always show a selected file. With
   an empty selection the inspector shows a folder summary (counts, direct-children
   size, path) instead of an empty tile.

## Comparison points inspected (concept vs. render)

| # | point | concept evidence | render evidence | result |
| --- | --- | --- | --- | --- |
| 1 | Shell composition | concept-a: sidebar / file table / inspector, single hairline status bar | `design/qa/04-explorer-dark.png` | match |
| 2 | Column model | concept-a: NAME SIZE MODIFIED PERMISSIONS OWNER with a sort chevron | same five columns, uppercase letterspaced, chevron on the sorted column | match |
| 3 | Selected row | concept-e: full-width tint + accent bar on the left edge | `06-selection-inspector.png`, `16-table-detail@2x.png` | match |
| 4 | Palette | concept-a: near-black canvas, one mint accent, no gradients | tokens sampled above; no gradient anywhere in the shell | match |
| 5 | Light theme | concept-d: white canvas, grey sidebar, mint-filled active host row | `13-light-theme.png` | match |
| 6 | Dialog anatomy | concept-c: title + close, uppercase labels, segmented auth, mint primary | `02-connection-dialog-dark.png` | match |
| 7 | Host-key dialog | concept-c: amber warning, monospace fingerprint in an inset, Cancel + Trust | `03-hostkey-dialog-dark.png` | match |
| 8 | Typography | concept-a/e: monospace numerals, uppercase micro labels, 13px body | audited at @2x in `16-table-detail@2x.png` | match |
| 9 | Icon treatment | concept-e: thin outline folders/files, 1px-class strokes | hand-built 16px outline set; audited at @2x | match |
| 10 | Density | concept-e: 30px rows with hairline separators | 30px rows, `--line-soft` separators | match |
| 11 | Terminal | concept-b: near-black inset, high-contrast prompt, mint success line | `09-terminal.png` | match |
| 12 | Transfer rows | concept-b: icon, name, right-aligned speed, 3px progress bar | `10-transfers.png`, `11-transfer-dock.png` | match |

## Copy diff

Every visible string in the shell, toolbar, table, inspector, dialogs and palette is
code-native product copy in the same language and register as the concepts. The
concepts' invented file names, host names and figures were replaced with real values
from the live connection — as intended, since the concept's data is mockup filler.

No hero eyebrow, kicker, badge or pill was introduced. The only labels are functional
section headings (`CONNECTIONS`, `TRANSFERS`, `INSPECTOR`, `TRANSFER QUEUE`) and
uppercase column headers, all of which are present in the accepted concepts.

## Known deviations

- The concept typeface is an Inter-like grotesque; the implementation ships a system
  stack (`Inter var` → `Segoe UI Variable Text` → `system-ui`) so the app has no font
  download and renders identically offline.
- Concept mockups show a window title bar with traffic lights; the product is a web
  app, so no OS chrome is drawn.

## Final verification run

Command: `npm run qa` (Chromium via Playwright) against the **production build** —
`npm run build && npm start`, one process serving both the API and the built web app.

Result: **no console errors, no page exceptions, no failed requests.** The single
non-2xx response is the designed `409 HOST_KEY_UNKNOWN` host-key challenge.

Captured states (`design/qa/`):

| file | state |
| --- | --- |
| `01-welcome-dark.png` | first run, no saved hosts |
| `02-connection-dialog-dark.png` | new-connection dialog, private-key auth |
| `03-hostkey-dialog-dark.png` | unknown host key, SHA-256 fingerprint |
| `04-explorer-dark.png` | explorer at the concept's native 1024×768 |
| `05-explorer-desktop.png` | explorer at 1512×900 |
| `06-selection-inspector.png` | row selected, inspector populated |
| `07-context-menu.png` | file context menu |
| `08-grid-view.png` | grid view with a selected tile |
| `09-terminal.png` | live PTY after `echo ssh-explorer-ok` |
| `10-transfers.png` | transfer manager view |
| `11-transfer-dock.png` | bottom transfer dock |
| `12-command-palette.png` | command palette (`Ctrl K`) |
| `13-light-theme.png` | light theme at 1024×768 |
| `14-mobile.png` | 430×860 |
| `15-tablet.png` | 834×1112 |
| `16-table-detail@2x.png` | 2× device-pixel detail for icon and type QA |
| `17-text-preview.png` | tokenised text preview with line numbers |
| `18-multi-select.png` | shift-range selection + multi-item inspector |
| `19-new-folder-dialog.png` | new-folder dialog |
| `20-rename-dialog.png` | rename dialog (`F2`) |
| `21-delete-confirm.png` | destructive-action confirmation |
| `22-empty-filter.png` | filter with no matches |
| `23-recursive-search.png` | recursive search below the current folder |
| `24-token-mode.png` | `SSH_EXPLORER_TOKEN` mode seeded from `?token=` |
| `desktop-installed-smoke.png` | the **installed** desktop app, launched from its Desktop shortcut |
| `desktop-e2e.png` | the packaged app during the SSH + download end-to-end run |

Functional assertions the driver makes on every run, beyond screenshots: opening one
terminal tab adds exactly one tab, the PTY echoes a command back, shift-click selects a
range, arrow keys leave exactly one row selected, the filter empty state renders, the
recursive search returns rows and clears cleanly, and no console error or failed request
occurs anywhere in the flow.
