# Synopsis persistence implementation plan

**Goal:** Preserve synopsis edits when saving, changing views, and refreshing scene lists.

**Scope:** Fix summary loss requested in chat. Analyze the second App Store review without changing navigation.

**Approach:** Reuse the existing scene-notes document lifecycle for synopses. Give every synopsis editing surface the same document, pending-save registration, retry handling, and workspace guard. Keep plain text unchanged, including intentional empty summaries.

**Constraints:** Preserve shared Markdown editing. Do not run Electron E2E tests on the interactive desktop. Leave the user's workspace-file edit untouched. Update only Unreleased in the changelog.

## Implementation

- [x] Reproduce focused-field save loss, unmount loss, and stale scene-list replacement using the real React properties component in Node/JSDOM.
- [x] Extend `useSceneNotesDocument(context, field = 'notes')` to support `synopsis` without checklist normalization.
- [x] Add `SceneSynopsisField.tsx` and use it in scene properties, the outliner, and both corkboard layouts.
- [x] Cover failed saves, retry, pending remount, intentional clearing, and edits made during a slow save.
- [x] Run the Node suites, typecheck, and aislop; review the final diff.
- [x] Record the user-visible fix in `CHANGELOG.md` and the synopsis saving behavior in the manual.

## Verification

`node --experimental-strip-types --test scripts/scene-synopsis-persistence.test.mjs`

`npm run test:transport`

`npm run typecheck`

`aislop scan --changes --json`

## Evidence

The initial four-case regression run had three assertion failures: pending text was absent from saved/reopened summaries, and a refreshed scene list replaced a newer draft. The normal blur-save control passed.

Commit and push the fix to `dev`. Leave the unrelated workspace-file edit uncommitted. No release is requested.

Review also reproduced stale Board previews, cancellation of another mounted field's load, and missed external metadata changes. Added regression coverage and corrected those paths. Shared synopsis editors keep their existing independent collaboration sessions. The local document now invalidates delayed reads when edited and preserves failed-load errors during workspace saves.

Final validation: 494 Node tests passed, one existing platform-specific relay test skipped; typechecking and production bundling passed. The 18 focused component/document regressions also passed independently during review. Aislop reported no errors or warnings. Electron E2E was not run on the interactive desktop.
