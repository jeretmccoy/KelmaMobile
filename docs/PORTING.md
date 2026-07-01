# AnkiDroid → Kelma Port Map

Baseline inspected on 2026-06-29:

- AnkiDroid `e6e941193fb4430dfa41d5931cdc6b762012ca30`
- AnkiDroid backend `0.1.64-anki25.09.2`
- packaged Anki/rslib `3890e12c9e48c028c3f12aa58cb64bd9f8895e30`
- packaged Android bridge `f9b78ba145a64692a08c93c08fc17c3b723179f0`
- local reference checkout `110cb8f3b1b3919fb4253e19810d87ca000436e6`

The backend version is intentionally pinned to the AnkiDroid baseline until the
Android and iOS bridge can be advanced together. The local reference checkout
is newer than the packaged core and must not be linked into only one platform.

| Milestone | AnkiDroid reference | Kelma target | Status |
|---|---|---|---|
| Foundation | `CollectionManager`, `libanki`, `rsdroid` | Typed TurboModule and shared core lifecycle | Android and iOS working |
| Collection + decks | `DeckPicker`, `CollectionManager` | Open/create collection, deck tree and counts | Next |
| Deck inspector | `StudyOptionsFragment`, `CardBrowser` (deck-scoped) | Per-deck overview + paged card browser | Done |
| Reviewer | `reviewer/`, `AbstractFlashcardViewer` | Shared reviewer shell, WebView card, answer actions | Pending |
| Editor | `NoteEditor`, multimedia fields | Shared note editor with platform media pickers | Pending |
| Sync | sync screens + backend sync calls | rslib sync against KelmaSync with progress UI; persisted credentials + home Sync button; per-deck pending badges | Done (incremental) |
| Import/export | `ImportUtils`, sharing flows | `.apkg`/`.colpkg` through rslib | Pending |
| Browser | card browser/search | rslib search grammar and paged results | Done (deck-scoped) |
| Settings | preferences | Shared settings plus small platform sections | Pending |
| Notifications | `NotificationService` | Native scheduled review reminders | Pending |
| Widgets/shortcuts | Android widgets and intents | Platform-specific thin entry points | Pending |

## Porting rules

1. Port behavior, not Android framework classes.
2. Query and mutate Anki data only through rslib.
3. Keep platform files focused on OS APIs and FFI lifecycle.
4. Build one shared screen unless platform interaction materially differs.
5. Preserve upstream attribution when adapting upstream implementation.
6. Add compatibility fixtures before broadening a core operation.

## First vertical feature

The next slice is deliberately small but real:

```text
launch
  → resolve profile collection path
  → open/create collection through rslib
  → fetch deck names and study counts
  → render shared deck list
  → close cleanly on profile switch
```

No placeholder deck repository will be added. This slice establishes the
collection lifecycle used by reviewer, editor, browser, import, and sync.
