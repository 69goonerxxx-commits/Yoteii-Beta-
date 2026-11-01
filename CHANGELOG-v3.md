# Yotei v4.0.0 (3.0.0 notes below)

Everything after 3.1.3 (the former 3.2.0, 3.2.1 and 3.2.2) is now part of 4.0.0.

Released as 3.0.0 (Oct 2026). The user-facing version of this list is the 3.0.0 entry in `about.js`.

## 4.0.0 · Inbox
- New `src/js/inbox.js` (plain functions, tested in `tests/mjs/inbox.test.mjs`): task shape `{ id, t, note?, imp?, at? }`, `stampOf` (old tasks have no `at`, so the time inside the id is used), `addedLabel`, `sortList`/`groups` (Important first, then the chosen sort inside each group), `stats`, `applyOrder` (a drag), `makeTask`, `insertNew` (new tasks go on top), `normalizePrefs`. Added to the `sw.js` SHELL.
- New store key `inboxPrefs` = `{ f:'all'|'imp', s:'manual'|'new'|'old'|'az' }` (filter and sort). `validate.js` accepts it and the new task fields (`note` string, `imp` boolean, `at` number).
- main.js: `drawInbox` rewritten (stats, filter, sort, Important/Later sections, empty state). Rows use `.ib*` classes; the container is `#inboxCard.ibx` (the old `.inbox` class is gone from it). A single tap on a row does nothing; two taps within 380 ms open the sheet (a hidden Edit button per row covers keyboard and screen readers). Holding a row for 380 ms picks it up (`touchmove` is cancelled while dragging); a drag only reorders inside its own section and sets the sort to Manual.
- Capture bar: `#inCap` (`#inCapT`, `#inCapF`, `#inCapGo`) is fixed above the tab bar and moves to the bottom when `body.kb` is set. The round + button is hidden on the Inbox tab (`styles.css`).
- `#qaDlg` is now a bottom sheet for both add and edit (`#qa_t`, `#qa_note`, `#qa_imp`, `#qa_sch`, `#qa_del`, `.isEdit` shows Schedule and Delete). `openInboxComposer()` (the + menu and the home-screen shortcut) opens it empty and stays on the current tab.
- The Inbox tab has a count badge `#inBadge`. Colour token `--imp` is the red used for the flag.
- To-do to Inbox and timeline to Inbox now keep the note (to-do note, or the block's details). Schedule from the Inbox puts the note into the task's details.
- Old Inbox CSS (`.inCards`, `.inCard`, `.inMain`, `.inT`, `.inGo`, `.inRm`, the old `#qaDlg` rules) is removed. The shared `.inEmpty`, `.inNew` and `.inbox` rules are kept because the To-do tab still uses them.
- Version 4.0.0 in `about.js` and `package.json`, `sw.js` cache `yotei-v4-0-0`. The one 4.0.0 entry in `about.js` also holds the former 3.2.0 to 3.2.2 notes.

## 4.0.0 · To-do tab
- New `src/js/todo.js` (plain functions, tests in `tests/mjs/todo.test.mjs`): `isOverdue`, `overdueCount`, `quickDate`, `weekDays`, `monthGrid`, `shiftMonth`, `addDays`. Listed in `sw.js` SHELL.
- `drawTodo` rebuilt. Header buttons live in `#tdHdr` (inside `.hdrR`, shown on the To-do tab only): `#tdHash` toggles the tag row, `data-vm` switches list or calendar. Smart chips (counts hidden at zero), then list chips with a dot and the + chip. No smart chips in calendar mode.
- Composer `#tdCap` reuses `.ibCap`. State is the view's defaults (`tdCapDef`: Today, Tomorrow, starred, or the calendar day) plus what the person changed (`tdCapOv`, reset when the view changes). It adds `{ l, due, dt, rep, star, tags }`. The round + (`#fab`) now shows on Home only; the + menu's "Add a to-do" still opens the editor.
- Tab badge `#tdBadge` (overdue count, `--bad`), refreshed in `drawTodo` and every 20 s.
- Date picker `#dpDlg` (`openDatePick(value, callback)`): used by the editor Date row, a card's date pill (`data-dp`) and the composer. Picking a time or repeat with no date sets the date to today; No date clears time and repeat.
- Editor `#tdeDlg` is a 90% sheet. All old ids are kept (`tde_t`, `tde_d` (now hidden), `tde_tm`, `tde_rep`, `tde_list`, `tde_tags`, `tde_color`, `tde_icon`, `tde_steps`, ...). `tdeSync` fills the grey summaries. Subtasks get a tick button (`.sdC`, only visible inside `#tdeDlg`); `makeSteps` takes an optional count formatter.
- `todoPrefs` gains `calWeek` (calendar shows one week). `validate.js` already accepts extra keys.
- Empty states: first use, filtered (Today, Upcoming, Starred), empty list, tag filter with no match, and the All caught up card. Old `.inEmpty`, `.inNew` and related CSS are removed.
- Polish: the empty-list art is the outline list icon in the list colour; a gradient (`#tab-todo::after`) fades cards under the composer; the editor's subtasks have a drag handle again (right side, before the remove button); the card drag handle sits beside the star so cards stay one row tall. Every open to-do has the handle now; dropping in a date-sorted group sets `todoPrefs.sort` to `mine` and shows a toast.

## 4.0.0 · Welcome tour (was 3.2.2)
- Welcome tour (#welDlg) goes from 5 to 8 pages: logo, wake time, **Routines and Run mode** (new), Home/School/Away, running late, Inbox/To-do, **Streaks and History** (new), **Let's set up your day** (new; carries the Structured credit). The logo page uses the new logo; its six orbs pop in with `.wlOrb` and `@keyframes wlPop`.
- New ids: `#wl_back` (Back button, hidden on page 1), `#wl_m1`..`#wl_m3` (sample cards the mode demo rewrites). The dots now carry `data-k` and are tappable (the hit area grows with `::after`); Left/Right arrow keys move between pages.
- Tapping Home, School or Away in the tour calls `welMode()` in main.js, which swaps the three sample task counts (`WEL_MODES`). `openWelcome` resets it to Home.
- Tour mini-screens use `var(--accent)` for checks, selected tabs, chips, buttons, the streak number and chart bars. Headlines and text use `text-wrap:balance`.
- Shipped as part of 4.0.0 (the 3.2.2 label was folded into 4.0.0).

## 4.0.0 · New logo (was 3.2.1)
- New logo. `assets/icon.svg` is the master (rounded square); `icon-192/512.png` come from it, `icon-180.png` and `icon-maskable-512.png` are full-bleed squares (the maskable one has the art at 80%). `assets/favicon.svg` and `favicon-32.png` are the small 予 mark (the SVG switches the kanji to white in a light browser theme).
- Loading screen: the full logo with the six orbs rippling (each orb sits on a solid navy circle so the ring never shows through while it fades), and the name as an outlined path (Sora SemiBold) so no font has to load first. The "Tap to skip" hint and its CSS are gone; `__bootSkip` and the `ready` class are untouched, so tapping still skips after 1.2s.
- Navy is now #0a1222 everywhere (loading screen, manifest, Android adaptive background and launch screen).
- `scripts/android-prepare.mjs`: the adaptive foreground drops the rounded-square clip so the orb's glow is not cut off; `ic_launcher_round.png` is built from the art at 80% on a full background so the orb is not cropped; the reminder icon is the 予 disc instead of the clock.
- `sw.js` caches the two favicon files and the cache name is now `yotei-v4-0-0`. The welcome tour now uses the new logo too (orbs pop in one by one on the first page).

## 4.0.0 · Repository restructure (was 3.2.0)
- Repository restructure, no behaviour change. `src/js/` holds the modules, `src/styles.css` the styles, `assets/` the icons, `scripts/` the build scripts (`build-www.mjs`, `android-prepare.mjs`) and `tests/mjs/` and `tests/py/` the tests. `index.html`, `sw.js` and `manifest.webmanifest` stay in the root so the service worker keeps whole-app scope.
- `scripts/build-www.mjs` now copies `index.html`, the manifest, `sw.js`, `src/` and `assets/` (the same set `pages.yml` publishes) and checks that every import and referenced file exists.
- `sw.js` SHELL, the manifest icons, the notification icons, the startup error box file list, the test imports and the workflows point at the new paths.

## 3.1.3
- Loading screen: #boot has an onclick (__bootSkip) that only works once main.js has set __bootReady and 1.2s have passed since __t0; a "Tap to skip" hint fades in at the same moment.
- Themes: util.js has PALS (id, name, base light|dark) and ACCENTS (a dark-surface and a light-surface value each). styles.css defines each surface as :root[data-pal=...] (dark and light stay the default :root and :root[data-theme=light] blocks; the new ones reuse the base light or dark rules). applyLook() sets data-theme (the base), data-pal, and the inline --accent and --onacc (black or white, whichever contrasts more). tests/themes.test.mjs checks every theme and accent combination for contrast (text 7:1, secondary text 4.5:1, accent 3:1 on bg and card, text on accent 4.5:1). Fixed-colour text on accent fills was changed to var(--onacc).
- List icon and colour: todoLists items gain `ic` (an icon key, default checklist) and `c` (a colour, missing means the accent for the main list or the old rotation for others). #tdlDlg has the icon button and the colour ring; the icon picker takes a target (ipTarget/ipSet) so it can serve the task editor and the list dialog.
- Tags: key `todoTags` ([{ id, name, c }]) shared by all lists, `tags` (array of tag ids) on a to-do. #tgDlg creates, edits and deletes (deleting also removes it from every to-do, with Undo). The to-do editor has a Tags row with + New tag; the list screen has a Tags filter row (tdTag, one tag at a time, combined with the selected list or smart view) and works in the calendar view too.
- Day types: `dayTypes` ([{ id, name }], missing means the ready-made Work and Sick) adds to the built-in Home, School and Away. syncTypes() rebuilds MODE_LABEL, MODE_NAME, WIN_LISTS and TASK_LISTS in place and adds a MODES entry (no deadline, no starter tasks) for each, so the block switcher, Usual days, the task editor's day-type picker and the copy sheet pick them up. Deleting a type removes its tasks (blocks[id]), clears it from every saved day and from Usual days, and asks first. getBlocks falls back to Home's empty list for an unknown type. The block switcher wraps onto a second row when there are more than four types.
- To-dos can carry `ic` (an icon key or emoji) and `c` (a colour). The card edge, list-view dots and calendar dots use `x.c` before the list's colour; the editor has an icon button (the shared picker via ipTarget) and the colour ring (prefix `tde`); Send to Timeline copies both into the task editor. The to-do editor's button row is sticky so Save is always visible.
- The to-do tag filter takes several tags (`tdTags`, a to-do needs all of them); Edit tag shows when exactly one is picked, and Clear resets.

## 3.1.2
- Smart views: chips `sv:today` (due today or earlier), `sv:upcoming` (due after today) and `sv:starred`, filtered by tdIn(); each shows a count of open to-dos. tdSel can be 'all', a smart view or a list id, so anything that needs a real list uses tdListSel(). A new to-do inherits the view (due today, due tomorrow, or starred).
- Calendar view: `todoPrefs.mode` is 'list' or 'cal'. tdCalHtml() draws a Monday-first month grid with up to three dots per day (list colour, red when overdue) and the selected day's to-dos below, using the same cards. Picking a smart view while in the calendar switches back to the list.
- Repeat: `rep` is d | wd | w | m | y and needs a due date (saving a repeat with no date uses today). tdNext() gives the next date after the current one and never before today; ticking a repeating to-do calls tdAdvance() (due moves on, subtask ticks reset) instead of marking it done, with Undo. Send to Timeline does the same instead of removing the to-do. Monthly and yearly clamp to the last day of a short month, so a to-do from the 31st drifts to the 28th after February.
- Edit list became a ⋯ icon button beside the view toggle.

## 3.1.1 (built in phases; later phases add to this entry)
- Phase 1, To-do tab: lists (`todoLists`: { id, name }, `main` always exists and cannot be deleted; a to-do's `l` is its list, missing means main), chips row with All and +, #tdlDlg to add, rename and delete a list (deleting moves its to-dos to the first list, with Undo). Quick-add shows a list picker when there is more than one list.
- Star (`star: true`) floats a to-do into its own group above the others. Drag handle (.tdH) reorders inside a group by rewriting the group's slots in the `todos` array (tdReorder). Handles only show with the My order sort.
- `todoPrefs` { sort: mine|az|new, done: bool }: Sort select, and the Done (n) header toggles the finished group. Clear done only clears the current view. validate.js knows todoLists and todoPrefs; both are in UNDO_KEYS.
- Phase 2, To-do editor (#tdeDlg, openTodoEd) replaces the quick-add box for to-dos; #qaDlg is Inbox only now. A to-do can carry `due` (YYYY-MM-DD), `dt` (HH:MM, only with a due date), `note`, and `steps` ([{ t, d }], each with its own done flag, unlike task steps, which keep done state per day). tdDue gives the label and the overdue flag (date passed, or today with a time that has passed).
- Groups on the list: starred, overdue (not starred), the rest, then done. Sort gains Due date. Tapping the subtask badge or note icon (tdOpen, in memory) opens the subtasks and note under the to-do; subtasks can be ticked there.
- Subtask rows were made into makeSteps() so the task editor and the to-do editor share one implementation.
- Phase 3: #tde_tl (Send to Timeline) closes the to-do editor, switches to the Timeline, jumps to the due day when it is today or later, and opens the one-off editor with the name, note (as Details) and subtasks filled in; the due time becomes the Start time. It sets cur.fromTodo, and #e_ok removes the to-do only when the task is saved, so cancelling loses nothing. #tde_inbox moves the to-do to the Inbox (name only, asks first when a date, note or subtasks would be dropped; Undo).
- One-offs scheduled from the Inbox or a to-do carry `src` ('inbox' | 'todo'). The engine already spreads block fields into rows, so rowHtml shows a "from Inbox" / "from To-do" tag next to the other tags. `src` survives later edits because it is not in the editor's FORM list.
- Polish pass: `.wn` had `margin:-4px 0 2px` and no line-height, which pulled notes into the line above; it now has positive spacing. Inbox and To-do content was inset 36px (tab padding 20 plus card padding 16); the card padding is gone so it lines up with the title. Subtask inputs lost their nested border. Inbox rows put Schedule and remove under the text instead of squeezing it.
- To-do cards (.tdItem with --lc, the list colour from TD_COLORS; the first list uses the accent). Default sort is `date` (tdPrefs.sort, old 'due' maps to it): sections Overdue, Today, Tomorrow, Upcoming, No date, each collapsible (tdPrefs.hide); drag only in No date. 'My order', A to Z and Newest first stay flat, with starred and overdue groups. The row delete cross is gone; the editor has Delete. The + chip sits outside the scrolling chips.
- Welcome tour rebuilt as full-screen pages (#welDlg): logo page, then four pages each with a headline and a drawn mini screen (.wlMock). Ids #wl_track, #wl_dots, #wl_next, #wl_skip are unchanged. The active page gets .on (entrance animation) and sets --g, the background tint.
- Bottom bar: the five tab icons now shrink on narrow screens (`.tabs .ti` width), so Settings is no longer cut off at 320px. Subtask rows got a 6px gap.
- Inbox items are cards (.inCard, accent edge, Schedule pill with a calendar icon, ✕), replacing .inItem/.inList. History and About text got line-height and margins (#tab-history p.wn, .about p, #replayWel). The changelog is grouped into month sections (.clMonth) built from each entry's `date` ('Oct 2026' becomes October 2026, 'Initial' becomes First release); add new entries at the top of CHANGELOG as before.

## 3.1
- Inbox: layout copied from the original (38px icon, short title, one New Inbox Task button). The inline composer is gone; New Inbox Task and the + menu open #qaDlg, a dialog pinned near the top, so the keyboard cannot resize the page. Text has side padding.
- To-do tab (tab-todo, key `todos`, items { id, t, done }): plain checklist between Inbox and Timeline, shared #qaDlg for add and edit, undo on delete and Clear done. Added to UNDO_KEYS, validate.js and the + menu.
- Subtasks: #e_steps rows (add one at a time, drag handle, remove, Enter adds the next, Backspace on an empty row removes it). Stored as the same `steps` array as before.
- Notes: saving a note no longer adds it to shownNotes, so notes stay hidden until the note icon is tapped.
- Welcome tour: #welDlg (4 swipeable cards). Shown on a fresh start, then the setup dialog follows. About has a Show the welcome tour button.
- Credit to Structured in About, the Settings menu footer and the last welcome card.
- Loading screen logo: 62vw up to 260px (was 42vw up to 170px).
- Version 3.1 (package.json 3.1.0), cache yotei-v3-1.

## 3.0.4
- Inbox: the composer no longer collapses on blur (that closed it under the keyboard on Android). It has a close button and Esc.
- Energy: tapping today's chosen level again removes that rating.
- Loading screen: dots r=7 (was 14), 6 seconds in the app. android-prepare.mjs patches AppTheme.NoActionBarLaunch (only when its parent is Theme.SplashScreen) with a plain #0A1226 background and a transparent icon.
- Blocks: new default colour and icon per window; the editor colours are a 6-column grid of 16 colours, Auto and the custom wheel.
- Task start and end dates can be edited in the task editor. They are applied to the task itself (and its linked copies), not as day-limited overrides, and are not shown on the timeline.
- Export and the automatic weekly backup go to Downloads/Yotei (YoteiFiles.saveToDownloads, MediaStore). trimBackups keeps the latest 8 yotei-auto-* files. Toggle under Settings > Backup.
- Reminders get Done and Snooze 10 min (action buttons). Done marks that task done for that day; Snooze schedules another notification in 10 minutes and remSync leaves snoozed ones alone.
- Weekly review (review.js, weekSummary) at the top of History.
- Week strip: no empty dots row until something is planned.
- Audit fixes: engine.js keeps every number sane (a missing, negative or huge length, a minimum above the length, a NaN wake time or cap) so a bad backup cannot produce NaN times; validate.js refuses out-of-range lengths, times, wake times and caps. A 60,000-day random test found no broken day with valid input and none with odd input after this.
- Light theme status text colours darkened for contrast. Small phones with large text: wake row wraps, usual days fit, cap rows wrap. Add task and reset buttons are a little taller.
- Settings > Schedule > Tasks with dates lists every task that has a start or end date (Active, Not started, Ended) with Edit and Remove, because an ended task leaves the timeline.
- Removed dead code: two overwritten handlers (#ts_del, #e_del) and five unused leftovers.

## 3.0.3
- Loading screen: #boot in index.html, the icon's ring, check and five dots, with the dots rippling. It leaves when main.js has drawn the first screen (the Android app keeps it up for at least 2 seconds, the website does not wait). The Welcome dialog waits until it has gone, because a dialog opens above everything.
- Task dates: the Add / Apply dialog has an "Or choose dates" card (Starts, Ends). Tasks carry from and to; engine.js shows a task only when the day is inside them, together with any chosen weekdays and day types. Edits and deletes use the existing from/to overrides. Backup validation accepts from and to as text.
- Done button in the header (body.editing) to leave editing mode.
- Energy buttons: colour and label per level, today's latest rating filled in and named underneath.
- Always starts on the Timeline (the last tab is no longer restored).
- Export in the Android app saves to Downloads through a small native plugin (YoteiFiles, generated by android-prepare.mjs, saved with MediaStore, needs Android 10+). Share keeps the share sheet. Without the plugin Export falls back to the share sheet.
- Panel corner radius 36 to 18.
- Settings menu: buildSettings() in main.js groups the existing cards into General (Reminders, Appearance, Schedule, Editing), Data (Backup, Calendar import, History data, Reset) and About (Science sources, About Yotei). The cards are moved into pages, not rebuilt, so every handler keeps working. Rows show a value (Reminders On/Off, Appearance, Editing, last Backup, version). The Android back button goes from a page to the menu, and tapping the Settings tab always shows the menu.
- Inbox: empty state (icon, title, text, New Inbox Task) and a list of cards once there are tasks. New Inbox Task opens the input; the + menu opens it too. tests/flows.py taps New Inbox Task and the Schedule row before using those controls.
- Header space: Capacitor padded the WebView below the status bar and also injected the same inset as a CSS variable, so the page added it a second time (an empty band above the title that vanished on scroll). SystemBars now uses insetsHandling "native" with viewport-fit cover hinted, so the CSS reads the inset only when the WebView really is edge to edge. The header sticks at the inset, with a strip in the page colour behind the status bar.
- Keyboard: while a text field is focused and the viewport has shrunk, body gets class kb: the tab bar, + button and week strip hide, and the field scrolls to the centre of what is left.

## 3.0.2
- Android reminders: scheduled with the phone (Capacitor Local Notifications) for today and the next two days, replanned whenever the screen changes or the app is opened. They fire with the app closed and are restored after a restart. Permission prompt, exact-timing setting and a test button are in Settings.
- In-app dialogs: all 20 browser confirm() and alert() popups are replaced by ask() and tell() in main.js and a msgDlg in index.html. Destructive buttons are red, Cancel is focused on questions, Esc and the Android back button count as Cancel. tests/flows.py accepts the new dialog automatically.
- Startup error panel: plain "Something went wrong" message with Export my data, Reload, Details and a dismiss button, replacing the red technical box. Export reads the saved data directly, so it works even if main.js never started, and uses the same file format and share sheet as Settings > Export. A missing app file is named in Details.
- Poppins bundled into styles.css (latin, weights 400 to 700). No Google Fonts request.
- Wording: "on this device" in the app, "in this browser" on the web.
- The Buffer time task is gone. Spare time before a departure is free time, and the message says so.
- New test (html-ids) fails if main.js asks for an element index.html does not have.

## 3.0.1
- Saves now start straight away. A change made in the last instant before the app closed or reloaded could be lost (measured: 60 of 60 in the worst case, now 0 of 60).
- Android app groundwork: Capacitor project and GitHub build, backups through the Android share sheet, back button handling, status and navigation bar spacing, no service worker inside the app.

## Under the hood
- Split the single 3,300-line file into modules (`engine.js`, `icons.js`, `validate.js`, `styles.css`, and more). No change in behavior, checked against v2.6.5.
- Scheduling engine is now a separate, tested module.
- App icons added (the install and notification icons were missing).
- A red error box now appears if the app fails to start, naming what failed.

## Fixes
- Saving: if storage is full or blocked, the app now says so and offers a backup. Before, it failed silently.
- Backups: importing now checks every part of the file and refuses damaged or newer-version backups with a reason, leaving your data untouched.
- Reset routine: now undoable for a few seconds. The warning text no longer says it can't be undone.
- Backup import check: backups containing the backup-reminder date, or the older wake-time format, were wrongly refused by the Phase 2 check. Fixed, and empty fields no longer cause a refusal.
- Icon guessing: no more wrong icons from letters inside words ("Start work" and "Party" no longer get the palette icon; headphones get the headphones icon; "Chart" gets the chart icon). Removed rules that could never apply.

## Storage
- Your data now lives in IndexedDB instead of localStorage: far more room, and saves are batched and flushed whenever the app is hidden or closed.
- On first launch your existing v2 data is copied over automatically. The old copy is left untouched and never read again.
- Automatic snapshots: once a day (first launch) and before every import, the last 7 are kept on the device. Settings, Backup, Snapshots lists them and can restore one (the current data is snapshotted first).
- Several open tabs or windows stay in sync.
- If IndexedDB isn't available, the app falls back to localStorage like v2 (no snapshots in that case).
- Clear data now also removes snapshots.

## Dates and backups
- Days are now stored as `2026-10-11` instead of `Sun Oct 11 2026`. They sort correctly and no longer depend on how the browser parses a date string.
- Existing data is converted automatically on first launch. A snapshot of the old data ("Before the update") is kept first.
- Backups are now version 3. Backups made by v2.6.5 still import and are converted on the way in. A v3 backup cannot be loaded by v2.6.5.
- Restoring a snapshot taken before the update converts it as well.

## Timeline and editor
- The timeline sits about 12px further left (icons, text and the vertical line). The tick buttons stay where they were.
- Free time is now shown everywhere it exists: before the first task, between tasks, after the last task, and for blocks with no tasks. Each gap has a broken line, a "free" label and an always-visible "+ Add task" that opens the editor at that time. Gaps under 5 minutes are not shown. Past days (saved records) show gaps without the add button.
- End time first: set an End time and Yotei counts back from it using the length (6:00 AM and 20 minutes gives a 5:40 AM start). The End stays put when the length changes. Typing a Start works as before.
- Editor error messages no longer vanish the moment they appear (the old "add a start time" message was hidden instantly).
- Day types: a task can be added to Home, School, Away, any two, or all three. One copy is saved per type, linked together. Editing a linked task updates every copy, and ticking or unticking a type adds or removes that copy. "Only this day" ignores the types. Morning and night routine tasks are unchanged.
- Icon picking: a cloud icon that is still downloading can no longer land on a different task later. The tile shows a loading state, gives up after 8 seconds with a message, and works out when offline.
- Toasts: wider, centered, above the round + button. They can no longer stay on screen (timestamp safety net), and tapping one dismisses it. Moving to another screen clears an older one.
- Delete always works: tasks with no id, a number as an id or a duplicate id are repaired at startup, a task filed in the wrong list is found, and deleting one that no longer exists just completes. On a past day, deleting removes the task from that day's saved record (with Undo). The "no longer in your routines" message now offers "Delete it".
