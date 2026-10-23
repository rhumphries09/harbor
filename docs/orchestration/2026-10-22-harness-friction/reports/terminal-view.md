# Stale `>_` terminal view over a correct conversation view

Run: 2026-10-22-harness-friction. Lane: terminal view. Nothing committed; every change is in the working tree.

## Root cause in plain words

The session was running Claude Code's fullscreen renderer (`"tui": "fullscreen"` in the config homes since at least 2026-08-24; CLI 2.1.303 also turns it on by default for a fresh install). In that mode the CLI draws on the alternate screen, turns on any-event mouse reporting, and keeps its own virtual scrollback, so where the conversation is scrolled to is state held by the CLI. It is not part of Harbor's view.

When the CLI's own view is scrolled up, it stops following new output. It starts following again only when a typed prompt lands, when the user scrolls back to the bottom, or when ctrl+End is pressed. A background task's turn does not count, because it is not a typed prompt. The `>_` view forwards the wheel to the CLI as soon as the CLI re-asserts mouse mode, which it does after every resize and every turn. So a scroll during a short `>_` peek leaves the CLI parked after the view closes.

Harbor's own pty resizes switch the pane between two sizes: the dialog size on focus or send, and the view's fit on open. Those resizes can also hide the CLI's "N new messages (ctrl+End)" pill. The next peek then opens onto the old screen with no cue at all.

The daemon's modeled screen and the view were faithful to the CLI throughout. The CLI simply was not at its bottom.

What the view showed is what the CLI was drawing:

- its message area parked at the moment just after the 15:45 local prompt;
- its fixed chrome below that (composer, statusline) repainted live.

The statusline is the tell. It read ctx 87%, which matches the last API call of the answer that followed (872,117 tokens at 21:12:31Z, against about 784k at the prompt). A frozen model or a frozen view would have kept the older statusline.

## Evidence

All live access was read-only: the daemon's `list` and `screen` verbs. Nothing was written, resized, signalled or observed.

- **Live pane read.** The pane for session 485530a9 is 152x33 and reports `scrollback_lines: 0`, which means the alternate screen. Its screen showed:
  - the sticky prompt header (the last typed prompt);
  - the tail of the earlier answer and "Brewed for 26s · done 3:32 PM";
  - the later prompt, cut off after 5 of its roughly 12 rows;
  - an empty composer and a current statusline.

  By the time of the read it also drew "9 new messages (ctrl+End) ↓", after the idle compaction at 22:08Z. The user's screenshot at 21:35:19Z shows the same parked view with no pill.
- **Renderer input log** (`~/.cache/harbor/input-diag.jsonl`).
  - The prompt landed at 20:45:39.36Z after a send retry.
  - The `>_` toggle went on at 20:45:42.06Z and off at 20:45:45.59Z.
  - The send log shows why the user looked: the first attempt at 20:44:05Z failed with "prompt never held ... Check the >_ terminal".
  - Later peeks: 20:50:20, 21:09:22, 21:13:43 (34 s, with a pointer release inside the terminal), 21:18:48, 21:19:01, 21:19:25 and 21:35:15.
  - Wheel events are not logged.
  - The parked view's bottom sits mid-prompt, about 8 rows above the end of the prompt. That fits a couple of wheel notches, not a resize (see the probes).
- **Real-CLI probes** (CLI 2.1.303, isolated sessiond with a relocated store and job namespace, haiku turns and bash-mode commands, raw frames recorded through `observe`):
  - Resizing between 120x60 and 152x33 does not unpin the view. That holds after a turn, mid-turn, 2.5 s after a long pasted prompt, and on a resumed copy of the incident transcript with its large history.
  - These do not unpin it either: mouse motion, focus out and in, a click on blank space, a click on the user's own prompt, a click on the statusline.
  - A wheel-up event (SGR 64) does unpin it. The pill shows ("Jump to bottom", then "1 new message"), and new output lands below the view.
  - Wheel at 152x33 shows the pill. A resize to 120x60 hides it while the view stays parked, and new output lands below with no pill. Resizing back shows it again.
  - ctrl+End (`ESC [1;5F`):
    - re-follows a scrolled view;
    - is a no-op at the bottom;
    - leaves a draft and its cursor alone;
    - does nothing in the `/model` picker;
    - does nothing in the classic inline renderer (no alternate screen, no mouse mode, cursor not moved).
  - The Left arrow on an empty prompt opens the CLI's agents panel. Esc interrupts a running turn.
  - Raw frames: `?1049h` arrives once at startup. `?1000h ?1002h ?1003h ?1006h` are re-sent after every resize and every turn. Update frames are absolutely positioned (CUP), so the backfill-then-frames replay is position-safe.
- **CLI 2.1.303 source** (read from the installed binary):
  - A typed submit re-follows ("ownSubmitLanded").
  - Any other row re-follows only if the user has not scrolled away.
  - The pill needs a divider that only a user scroll sets, and it is evaluated against the current geometry.

## Fix

For a pane the daemon records as `agent: claude`, the terminal bridge sends the CLI's own "Jump to bottom" key (ctrl+End):

- when its `>_` view opens, once the observe relay is up, so the CLI's repaint reaches the view as held frames;
- when the view closes, so Harbor's pane readers (the window's live work meter among them) never read a parked screen.

It is never sent:

- on a daemon-reconnect re-attach;
- while a send holds the pane;
- to codex, cursor or unidentified panes.

The `>_` view now does again what it did for an inline terminal: it opens on the live output, and scrolling inside it lasts only while it is open.

Why this is the design and not a papered-over refresh: the fault is CLI-side scroll state that outlives a view the user has already left. The only correct owner of that state is the CLI. The key used is the one the CLI itself shows the user for exactly this ("Jump to bottom (ctrl+End)"), and it was measured harmless in every state tried.

Files and hunks:

- `app/src/main/terminal-bridge.js`
  - New `LIVE_BOTTOM_KEY` and `LIVE_BOTTOM_AGENTS`, with the incident comment, after `BACKFILL_LINES`.
  - `attemptReconnect` calls `applyVisiblePanes(panes, { reattach: true })`.
  - New `paneAgent(paneId)` reads the agent off the held snapshot's layouts.
  - New `returnToLiveBottom(paneId)` writes the key through the daemon client. It skips closed bridges, non-claude panes and held panes, and ignores exited panes.
  - `applyVisiblePanes(panes, { reattach })`:
    - a closing pane gets the key, not awaited;
    - an opening pane awaits `observer.ready`, then the key, then the backfill as before.
- `app/src/main/session-daemon/streams.js`: `attachObserver` puts `entry.ready` on the entry it returns. It settles true when the daemon's observe reply arrives (after the keeper registered the observer) and false on error. It never rejects.
- `docs/claude/views.md`: one new bullet after the "A PROMPT DRAWN ONLY IN THE TERMINAL" bullet.
- New `app/test/main/terminal-live-bottom.test.js` (CI): six specs covering who gets the key and when.
- New `app/test/daemon/terminal-live-bottom.test.js` (local gate): the real bridge and supervisor against a real isolated sessiond, two-sided, with a codex control.
- New `app/test/support/fullscreen-claude-standin.js`: a console stand-in that keeps the measured scroll contract.
- New `app/scripts/drive-terminal-live-bottom-win.js`: a live drive against the real CLI through the real bridge, two-sided. `HARBOR_DRIVE_BRIDGE_MODULE` points it at another checkout.

## Two-sided tests

Pre-fix runs swapped in the HEAD copies of `terminal-bridge.js` and `streams.js` for the run, then restored the fix.

**`test/main/terminal-live-bottom.test.js`**

Pre-fix, 1 pass and 5 fail:

```
✖ opening a claude pane's >_ view sends ctrl+End once the relay is up, before the backfill paints
✖ closing the view sends it again, so a scroll inside the peek does not outlive it
✔ codex, cursor and unidentified panes are never sent it
✖ a send in flight keeps the pane: closing the view mid-send sends nothing
✖ a daemon reconnect re-attaches without moving a reader's place
✖ the supervisor's observer entry says when the relay is up, and never rejects
ℹ tests 6  ℹ pass 1  ℹ fail 5
```

The one that passes is a negative spec, so it passes on both versions by design. Post-fix: `ℹ tests 6  ℹ pass 6  ℹ fail 0`.

**`test/daemon/terminal-live-bottom.test.js`**

Pre-fix:

```
✖ a >_ peek leaves a fullscreen claude following its output, and the next peek opens on it
  AssertionError: closing the view left the session's screen parked where the peek scrolled it:
  message 25 ... message 34 / ---- / standin scrolled 45
✔ control: the same peek on a codex pane is never sent the key, and stays where it was scrolled
```

Post-fix: `ℹ tests 2  ℹ pass 2  ℹ fail 0`.

**`scripts/drive-terminal-live-bottom-win.js`** (real CLI 2.1.303, haiku)

- Pre-fix: `PROOF FAILED: session screen STALE, reopened view STALE`. Both screens are parked under "1 new message (ctrl+End) ↓".
- Post-fix: `PROOF OK: the peek left the CLI following its output, and the reopened view shows it`. It passed twice, the second time on the final code.

## Gate results

`npm test -- --exclude daemon --exclude bin` (264 files):

- Parallel pass: `ℹ tests 2604  ℹ suites 3  ℹ pass 2593  ℹ fail 0  ℹ cancelled 0  ℹ skipped 11`.
- Serial pty pass: `ℹ tests 7  ℹ pass 7  ℹ fail 0`.

Daemon suites touching the screen and stream code:

- `test/daemon/screen`: 20 of 20.
- `test/daemon/sessiond.test`: 8 of 8.
- `test/daemon/terminal-live-bottom`: 2 of 2.

## Siblings checked

- **Fixed in the same change.** The close side: Harbor's own pane readers read the bottom rows of the same screen, and a parked fullscreen CLI shows no spinner there. The window's live work meter would go blank mid-turn.
- **Not fixed: width table.** The renderer `XtermPane` (xterm 5.5) loads no Unicode 11 width addon. The daemon model (xterm-headless 6.0, `screen.js`) does, because ConPTY counts emoji as two cells. Rows holding emoji can therefore draw shifted in the `>_` view. This is the view-side twin of the 2026-09-03 model fix. It needs a new renderer dependency and was found by reading the code only; it is not verified on screen.
- **Not fixed: attach replays plain text only.** It carries no alternate-screen, mouse, focus or attribute state. In a freshly opened view the wheel scrolls xterm's own empty scrollback until the CLI next re-asserts mouse mode, after which it scrolls the CLI. Colors arrive only as cells repaint.
- **Not fixed: other CLI-side views a peek can leave behind.**
  - The agents panel (Left arrow): the send path already refuses it honestly (`isFleetView`).
  - Transcript mode (ctrl+o): no guard found. Its exit key, Esc, would also interrupt a running turn.
- **Unchanged.** The pane switching between the dialog size on focus or send and the view's fit on open. It no longer matters for staleness, because the CLI is left following whenever no view is open.

## What going live needs

- Main-process code only, so: **relaunch the Harbor app**.
- No daemon handover; no daemon or keeper file changed.
- No renderer rebuild; no renderer file changed.

After the relaunch, opening `>_` on the session that is parked right now re-follows it. Until then, ctrl+End inside its `>_` view does the same by hand.

## Not proven

- Which input scrolled the live session at about 20:45:42Z. Wheel events are not logged. The parked position fits a couple of wheel notches, and every other Harbor action tried left the CLI pinned.
- Why the pill was missing in the 21:35 screenshot specifically. The probes show that geometry changes hide and show it; the exact sequence in the live pane is not recoverable.
