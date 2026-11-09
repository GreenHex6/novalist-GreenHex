import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadRendererSource } from './renderer-source-loader.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
function store(initial) {
  let state = initial
  const listeners = new Set()
  return { getState: () => state, setState: patch => {
    const previous = state
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    for (const listener of listeners) listener(state, previous)
  }, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
}
function harness(initialNative = {}, mainWindow = true) {
  const panes = loadRendererSource('src/stores/shellPanes.ts', {}, { localStorage: { getItem: () => null } })
  const first = panes.newLeaf('write')
  const shell = store({ panes: first, activePaneId: first.id, notesDockVisible: false })
  let native = { docked: false, visible: true, pinned: true, follow: true, context: null, ...initialNative }
  let publish = () => {}
  let toggles = 0
  const forwarded = []
  let resolve
  let requests = 0
  const transfer = new Promise(done => { resolve = done })
  const notes = loadRendererSource('src/shell/sceneNotesDocking.ts', {
    react: { useEffect: effect => effect() }, 'react-dom': { flushSync: fn => fn() }, zustand: { create: fn => store(fn()) },
    '../stores/shellStore': { useShellStore: shell, paneLeaves: panes.paneLeaves },
    '../stores/shellPanes': panes,
    './sceneNotesPlacement': { readNotesPlacement: () => null, saveNotesPlacement: () => {} },
    '../stores/pendingWrites': { flushPendingWrites: async () => {} },
    '../stores/hostBridgeStore': { useHostBridgeStore: { getState: () => ({ pushToast: () => {} }) } },
    '../i18n': { default: { t: key => key } }, './useWorkspaceWindow': { flushWindowWrites: async () => {} }
  }, { window: { novalist: {
    onSceneNotesState: handler => { publish = handler; return () => {} },
    sceneNotesWindowState: async () => native,
    forwardMainCommand: command => forwarded.push(command),
    toggleSceneNotes: async () => { toggles++; native = { ...native, visible: !native.visible }; publish(native) },
    dockSceneNotes: async () => { requests++; await transfer; native = { ...native, docked: true, visible: true }; publish(native) },
    hideSceneNotes: async () => { native = { ...native, visible: false }; publish(native) }
  } } })
  if (mainWindow) notes.useSceneNotesDocking()
  return { panes, shell, notes, resolve, forwarded, publish: state => publish(state), get requests() { return requests }, get toggles() { return toggles }, get native() { return native } }
}

test('detached Notes commands route docked notes to the main window that owns their position', async () => {
  const h = harness({ docked: true, visible: true }, false)
  await h.notes.toggleSceneNotes()
  assert.deepEqual(h.forwarded, ['app.toggleSceneNotes'])
  assert.equal(h.toggles, 0)
  assert.equal(h.notes.useNotesDocking.getState().placing, false)
})

test('detached Notes commands keep floating notes local to their window', async () => {
  const h = harness({ docked: false, visible: false }, false)
  await h.notes.toggleSceneNotes()
  assert.equal(h.native.visible, true)
  assert.deepEqual(h.forwarded, [])
})

test('restored notes without a saved slot do not cover project views with the placement picker', async () => {
  const h = harness({ docked: true, visible: true })
  await turn()
  assert.equal(h.notes.useNotesDocking.getState().placing, false)
  for (const view of ['dashboard', 'manuscript']) {
    h.shell.setState({ panes: h.panes.newLeaf(view) })
    h.publish(h.native)
    assert.equal(h.notes.useNotesDocking.getState().placing, false, `${view} must remain accessible`)
  }
})

test('cancelled notes placement stays dismissed when scene context is published', async () => {
  const h = harness({ docked: true, visible: true })
  await turn()
  h.notes.placeSceneNotes()
  h.notes.useNotesDocking.setState({ placing: false })
  h.publish({ ...h.native, context: { sceneId: 'scene' } })
  assert.equal(h.notes.useNotesDocking.getState().placing, false)
})

test('the Notes command explicitly recovers a missing dock position on the first click', async () => {
  const h = harness({ docked: true, visible: true })
  await turn()
  h.notes.useNotesDocking.setState({ placing: false })
  await h.notes.toggleSceneNotes()
  assert.equal(h.notes.useNotesDocking.getState().placing, true)
  assert.equal(h.toggles, 0)
})

test('the Notes command toggles an existing dock without asking for its position', async () => {
  const h = harness({ docked: true, visible: true })
  await turn()
  const editor = h.shell.getState().panes
  const layout = h.panes.dockNotesPane(editor, editor.id, 'right')
  h.resolve()
  h.shell.setState({ panes: layout })
  await turn()
  h.notes.useNotesDocking.setState({ placing: false })
  await h.notes.toggleSceneNotes()
  assert.equal(h.native.visible, false)
  await h.notes.toggleSceneNotes()
  assert.equal(h.native.visible, true)
  assert.equal(h.shell.getState().panes, layout)
  assert.equal(h.notes.useNotesDocking.getState().placing, false)
})

test('docking survives a layout replacing the target while the floating editor saves', async () => {
  const h = harness()
  await turn()
  const pending = h.notes.dockSceneNotesAt(h.shell.getState().activePaneId, 'top')
  await turn()
  const replacement = h.panes.newLeaf('write')
  h.shell.setState({ panes: replacement, activePaneId: replacement.id })
  h.resolve()
  await pending
  const leaves = h.panes.paneLeaves(h.shell.getState().panes)
  assert.equal(leaves.filter(p => p.view === 'sceneNotes').length, 1)
  assert.ok(leaves.some(p => p.id === replacement.id))
  assert.equal(h.native.docked, true)
})

test('restoring then resetting a layout during transfer leaves notes hidden and the editor reachable', async () => {
  const h = harness()
  await turn()
  const editor = h.shell.getState().panes
  h.shell.setState({ panes: h.panes.dockNotesPane(editor, editor.id, 'right') })
  await turn()
  assert.equal(h.notes.useNotesDocking.getState().transferring, true)
  h.shell.setState({ panes: h.panes.newLeaf('write') })
  h.resolve()
  await turn()
  assert.equal(h.native.visible, false)
  assert.equal(h.shell.getState().panes.view, 'write')
  assert.equal(h.notes.useNotesDocking.getState().transferring, false)
})

test('repeated saved layout changes share a single native handoff', async () => {
  const h = harness()
  await turn()
  const editor = h.shell.getState().panes
  const layout = h.panes.dockNotesPane(editor, editor.id, 'right')
  h.shell.setState({ panes: layout })
  await turn()
  h.shell.setState({ panes: h.panes.reidentify(layout) })
  await turn()
  assert.equal(h.requests, 1)
  h.resolve()
  await turn()
  assert.equal(h.native.visible, true)
})
