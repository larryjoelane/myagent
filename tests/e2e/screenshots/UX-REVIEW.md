# MyAgent — UX Review

Based on screenshots in this folder. Generated 2026-04-28 against the current AgentManager + Test panel + terminal layout.

The user's own assessment matches what the screenshots show: the chat window is rough, attaching workers is awkward, and the layout is inconsistent (one terminal pane, then another with tabs, with no clear relationship between them).

This review groups issues by severity. Each item names what to change and where the offending code lives.

---

## Top-line problems (the things that make it unusable today)

### 1. The user has no idea what to do on first launch
**Screenshot:** `01-cold-start.png`

You see: a black terminal pane with a `❯` prompt and "bypass permissions on..." hint floating in the middle of the screen. Topbar has four buttons (`New Shell`, `Close Pane`, `AgentManager`, `Test`) with no labels explaining what they do.

There's no welcome state, no guidance, no arrow pointing at `AgentManager`. A new user has no reason to discover the chat. They'd assume this is a normal terminal app.

**Fix:**
- Add an empty-state in the main pane when no PTY is active: large centered text like "Open the AgentManager (top-right) or run `claude` in a terminal to start."
- Or auto-open AgentManager on first launch.
- Recommended: the latter. The chat is the primary surface — it should be visible by default.
- Files: `renderer/index.html` (initial layout), `renderer/agentManager.js` line 19-23 (`show(open)` — call `show(true)` on init).

### 2. The terminal layout is inconsistent
**Screenshots:** `03-test-panel-with-pane.png`, `05-agent-manager-with-worker.png`

You see: main pane on the left (no tab strip, just a terminal). Then an extra pane on the right with a tab strip at the top showing "Shell 1" + a `+` button. They look like two completely different surfaces. The main pane can't have tabs; the extra pane can't avoid having them.

This forces the user to think "is the thing I want a main-pane terminal or a tab-pane terminal?" — a question that has no good answer.

**Fix:**
- Drop the main/extra distinction. One terminal area, with a tab strip at the top. First terminal opens as Tab 1. New Shell opens Tab 2, etc.
- This is a meaningful refactor of `renderer/shell.js` (the PaneManager class), but it removes the most confusing part of the UI.
- Alternative cheaper fix: hide the main pane entirely and treat the extra pane as the only terminal area. Less disruptive, same UX outcome.
- Files: `renderer/index.html` lines 21-34 (the split structure), `renderer/shell.js` (PaneManager).

### 3. Attaching a worker requires opening a separate "Test" panel
**Screenshots:** `03-test-panel-with-pane.png`, `04-worker-attached.png`

You see: AgentManager on the left says "open the Test panel and attach a pane" — but the Test panel is itself a debug/diagnostic UI cluttered with raw JSON output, memory store inputs, source/tags fields, search query, and timestamped logs. Having to switch into a developer tool to do a primary user action ("attach this terminal as a worker") is wrong.

**Fix:**
- Move the attach UX into AgentManager itself. When no workers are attached, the empty-state in the chat should list available panes with an "Attach" button per pane — exactly like the Test panel does, just nicer.
- After attach, show a small "Worker Panes" section in AgentManager (collapsed by default once you have workers) where you can attach more or detach.
- Delete (or hide behind a debug flag) the Test panel. It shouldn't be a primary topbar button.
- Files: `renderer/agentManager.js` (add a no-workers empty state with attach UX); `renderer/testPanel.js` (move attach handling out, keep test panel for diagnostic only); `renderer/index.html` line 18-19 (remove Test from topbar by default).

### 4. The chat pane is empty and lifeless when no workers are attached
**Screenshot:** `02-agent-manager-empty.png`

You see: a 480px-wide column with `AgentManager` title, a tiny "save" checkbox, an X, then italic text "No attached workers — open the Test panel and attach a pane." That's it. The compose box at the bottom is enabled but unusable.

The empty state should be the entry point, not a dead end. A user looking at this thinks "broken."

**Fix:**
- Empty state should be active. Big call-to-action: "Attach a terminal to start chatting" with a primary button that opens a chooser of available panes (or creates one if there are none).
- Disable the compose box visually (gray it out, change placeholder to "Attach a worker first").
- Show the value prop — one line like "Send prompts to claude. Responses appear here."
- Files: `renderer/agentManager.js` `renderWorkersStrip()` (the empty-message branch), `renderer/index.html` lines 56-65 (the compose div — add a disabled state).

---

## Medium-impact problems

### 5. Worker chip shows a useless name (`@pane:main`)
**Screenshots:** `04-worker-attached.png`, `07-prompt-typed.png`

You see: the attached worker chip says `@pane:main`. That's an internal id, not a name. Auto-naming based on `paneId` isn't user-friendly.

**Fix:**
- When attaching, suggest a name: "Worker 1" / "Worker 2" or a random word ("agent-blue", "agent-red"). Let the user rename inline by clicking the name.
- For `@`-mention parsing, accept the new name format. Pin the existing `pane:N` only as a fallback.
- Files: `electron/main.js` `pane:attach-worker` handler (line ~336 — change default `name` from `pane:${paneId}`); `renderer/agentManager.js` (add inline rename on chip).

### 6. The compose-box hint text is doing too much work
**Screenshot:** `02-agent-manager-empty.png`, others

You see: "Type @ to pick a worker, then your message. Enter to send, Shift+Enter for newline." All in the placeholder. That's three pieces of information jammed into a textarea.

**Fix:**
- Placeholder should be the action: "Message your worker..."
- Shortcuts (`@` for picker, Shift+Enter for newline, Enter to send) belong in a tiny help affordance — a `?` icon at the corner of the compose box, or a one-time tooltip.
- Files: `renderer/index.html` line 60 (textarea placeholder).

### 7. The "save" toggle next to the close button is undiscoverable
**Screenshot:** `02-agent-manager-empty.png`

You see: a tiny checkbox labeled "save" between the title and the X. No icon, no tooltip text visible, no explanation. A user has no way to know it controls memory mirroring.

**Fix:**
- Replace with an icon button: "↓" or 💾 with a tooltip "Save chats to memory".
- Or move it to a settings drawer / overflow menu — it's not a frequent toggle.
- Currently the chip-level toggle is even worse: it's another tiny "save" on each worker chip.
- Files: `renderer/index.html` lines 47-50 (header toggle); `renderer/agentManager.js` lines 96-114 (per-chip toggle).

### 8. Mention popup positioning is broken / invisible
**Screenshot:** `06-mention-popup.png`

You see: User typed `@`, but the popup that should suggest workers isn't visible. Looking at the screenshot, the popup either didn't render or rendered offscreen. (No workers were attached when this screenshot was captured — that's a different issue: the popup should still show "no workers" rather than nothing at all.)

**Fix:**
- Even with no workers, show "@ — no workers yet. Attach one first." in the popup.
- Verify popup z-index and `bottom: 100%` positioning works above the compose box (it currently uses `position: absolute` on the compose div, which may be cut off if compose isn't sized right).
- Files: `renderer/agentManager.js` `updateMentionPopup()` (lines 230-258); `renderer/style.css` `.mention-popup` rules.

### 9. Topbar buttons are unstyled and indistinct
**Screenshot:** All

You see: `New Shell` / `Close Pane` / `AgentManager` / `Test` all look like the same generic gray button. AgentManager is the primary action — it should be visually different. Test should look secondary or be hidden in dev/debug.

**Fix:**
- AgentManager button: primary style (filled, accent color).
- New Shell / Close Pane: icon-only or muted.
- Test: hide unless `process.env.MYAGENT_DEV` is set, or move to a "..." overflow menu.
- Files: `renderer/index.html` lines 14-21 (topbar); `renderer/style.css` `.cmd-btn` (add `.cmd-btn--primary`).

### 10. Two terminal panes both visible by default is wasteful
**Screenshots:** `04-worker-attached.png` and after

You see: After clicking New Shell, you have the AgentManager (480px) + main pane terminal + extra pane terminal + Test panel (420px). At 1400px viewport, that's four columns of stuff, each cramped, none focused. The terminals show partial content — separator lines and "rupt" text fragments because they're too narrow.

**Fix:**
- AgentManager and the terminal area should be the only two panes by default. Test panel slides in over the chat (overlay), not as a third column.
- When AgentManager is open, terminal area auto-shrinks to a single column (no main vs. extra split).
- "New Shell" creates a tab in the unified terminal area, not a separate pane.
- This is the same fix as #2 — just stating the layout consequence.
- Files: `renderer/style.css` `#split` and `.pane` rules; `renderer/shell.js` PaneManager.

### 11. The terminal pane shows `rupt` (cut-off "interrupt") because the AgentManager covers it
**Screenshots:** `04-worker-attached.png`, `05-agent-manager-with-worker.png`

You see: The text "rupt" floating in the middle of the screen is the tail end of "esc to interrupt" — claude's hint bar from the *first* (main) pane, partially visible behind the AgentManager drawer.

This is the same root issue as #2 (two-pane layout) plus the AgentManager being a fixed-position overlay rather than claiming layout space — the first terminal renders into the area covered by the drawer, but the drawer is opaque so you only see what spills past.

**Fix:**
- AgentManager should be docked to the layout (push terminals over) when opened, not floating on top of them.
- Or: when AgentManager opens, hide the main pane entirely and only show the extra pane.
- Files: `renderer/style.css` `.agent-manager` (currently `position: fixed`, change to flex item); `renderer/shell.js` (resize on AM open/close).

---

## Smaller polish issues

### 12. AgentManager title should match the topbar button
The button says "AgentManager" (one word), the panel title says "AgentManager" — fine, but the user's clarification asked for consistency. The chat-pane title could just say "Chat" or "Messages" since the panel name is metadata, not user-facing.

### 13. Color palette is muddled
There's at least four shades of dark gray (#1a1a1a, #1e1e1e, #222, #252525, #2a2a2a, #2d2d2d, #3a3a3a, #3c3c3c) being used for various backgrounds and borders. Without an intentional system, it reads as inconsistent rather than layered.

**Fix:** Pick three: surface, elevated, divider. Map them to CSS custom properties. `renderer/style.css` could use a small token system at the top.

### 14. No keyboard shortcut to focus the chat input
Opening AgentManager doesn't auto-focus the textarea. User has to click into it. Same for after attaching a worker.

**Fix:** `renderer/agentManager.js` `show(open)` — add `inputEl().focus()` when open=true.

### 15. The user prompt blue (`#264f78`) is the same blue as the worker chip when active. Reuse without semantic distinction is confusing.

### 16. Send button is a generic gray "Send" button
**Screenshots:** Most. It's tucked next to the textarea but indistinguishable from the close-X.

**Fix:** Make it primary-color. Or replace with a paper-airplane icon.

### 17. Memory save toggle has no visible feedback when off
**Screenshots:** `02-agent-manager-empty.png` shows it on. When off, the checkbox just unchecks — no icon change, no chip color change, no banner saying "memories paused for this worker."

### 18. There's no visible indication that a worker is "thinking" / actively processing
When a prompt is sent, the assistant bubble appears but stays empty until response arrives. No spinner, no "..." indicator. User doesn't know if the system is working.

**Fix:** When a turn is open and assistantBuffer is still empty, show a typing indicator inside the bubble. `renderer/agentManager.js` `appendToOpenBubble` and `pushBubble('assistant', ...)`.

### 19. Empty state when AgentManager opens uses different language than the test panel
- AgentManager: "No attached workers — open the Test panel and attach a pane."
- Test panel: "No PTY panes open. Use 'New Shell' to open one."
Both refer to the same conceptual gap (no workers / no terminals) with different vocabulary. Pick one term ("worker"? "agent"?) and use it consistently.

---

## What I'd do first (top 5, ranked)

If we picked five things to change before showing the app to anyone else:

1. **Unify the terminal area** — drop main pane vs. extra pane, single tabbed area. (#2, #10, #11)
2. **Move attach UX into AgentManager** — kill the Test-panel detour. (#3, #4)
3. **Open AgentManager by default** with a useful empty state. (#1, #4)
4. **Rename `pane:main` workers** to something human, with rename support. (#5)
5. **Make the chat pane visibly active** during a turn (typing indicator, send-button feedback). (#16, #18)

These five changes alone would move the UI from "rough demo" to "actually usable." Everything else is polish that lands cleaner once the structure is right.

---

## Screenshots produced

| File | State |
|---|---|
| `01-cold-start.png` | App just launched, no panels |
| `02-agent-manager-empty.png` | AgentManager open, no workers |
| `03-test-panel-with-pane.png` | Test panel + AM both open, panes listed |
| `04-worker-attached.png` | One worker attached |
| `05-agent-manager-with-worker.png` | AM showing one worker chip |
| `06-mention-popup.png` | After typing `@` (popup not visible — bug) |
| `07-prompt-typed.png` | Prompt in compose box, ready to send |
| `08-mid-response.png` | After send, mid-response state |
| `14-both-panels-open.png` | Both AM + Test panels open simultaneously |

Rerun: `npx playwright test --config tests/e2e/playwright.config.js tests/e2e/screenshots.spec.js`
