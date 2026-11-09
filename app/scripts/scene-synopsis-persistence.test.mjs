import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { MessageChannel } from 'node:worker_threads'

const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx', contents: `
    import React, { act } from 'react'
    import { createRoot } from 'react-dom/client'
    import { SceneNotesFields } from './src/renderer/src/shell/SceneNotesFields'
    import { SceneSynopsisField } from './src/renderer/src/shell/SceneSynopsisField'
    import { useProjectStore } from './src/renderer/src/stores/projectStore'
    import { useManuscriptStore } from './src/renderer/src/stores/manuscriptStore'
    import { flushPendingWrites } from './src/renderer/src/stores/pendingWrites'
    let root
    const pair = hidden => <>
      {!hidden && <SceneSynopsisField key="first" chapterGuid="chapter" sceneId="scene" id="dock-synopsis" className="test-synopsis" />}
      <SceneSynopsisField key="second" chapterGuid="chapter" sceneId="scene" id="second-synopsis" className="test-synopsis" />
    </>
    export async function mount(kind = 'properties') {
      root = createRoot(document.getElementById('root'))
      await act(async () => root.render(kind === 'pair' ? pair(false) : kind === 'properties' ? <SceneNotesFields includeNotes={false} />
        : <SceneSynopsisField chapterGuid="chapter" sceneId="scene" id="dock-synopsis" className="test-synopsis" multiline={kind === 'card'} />))
    }
    export async function unmount() { await act(() => root.unmount()) }
    export async function refresh(synopsis) {
      await act(() => useProjectStore.setState(state => ({ chapters: state.chapters.map(chapter => ({
        ...chapter, scenes: chapter.scenes.map(scene => ({ ...scene, synopsis }))
      })) })))
    }
    export const change = act
    export async function hideFirst() { await act(async () => root.render(pair(true))) }
    export const snapshot = () => ({ project: useProjectStore.getState(), manuscript: useManuscriptStore.getState() })
    export async function flush() { await act(async () => { await flushPendingWrites() }) }
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'synopsisFixture', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'synopsis-services', setup(builder) {
    const services = {
      projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({
        projectPath: '/project', activeBookId: 'book', activeDraftId: 'draft', workspaceEpoch: 1,
        openChapterGuid: 'chapter', openSceneId: 'scene',
        chapters: [{ guid: 'chapter', scenes: [{ id: 'scene', title: 'Opening', synopsis: '' }] }]
      }))`,
      manuscriptPropsStore: `const state = { definitions: [], sceneValues: {}, load() {} };
        export const useManuscriptPropsStore = Object.assign(select => select(state), { getState: () => state })`,
      manuscriptStore: `import { create } from 'zustand'; export const useManuscriptStore = create(() => ({
        sections: [{ chapterGuid: 'chapter', scenes: [{ sceneId: 'scene', synopsis: '' }] }]
      }))`,
      client: 'export const rpc = window.synopsisRpc',
      'react-i18next': 'export const useTranslation = () => ({ t: key => key })',
      sharedProjectNotifications: 'export const useSharedProjectRevision = () => 0',
      sharedMarkdown: 'export const openSharedMarkdown = () => { throw new Error("Unexpected shared document") }',
      SharedPropertyField: 'export const SharedPropertyField = () => null',
      SceneCastPicker: 'export const SceneCastPicker = () => null',
      SharedMetadataField: `export const metadataBinding = () => undefined;
        export const SharedMetadataField = ({ value, children }) => children({ value, editable: true, change() {} })`,
      MarkdownEditor: 'export const MarkdownEditor = () => { throw new Error("Unexpected shared editor") }'
    }
    builder.onResolve({ filter: /./ }, args => {
      if (args.path === 'react-dom/client') return
      const key = args.path.split('/').at(-1)
      if (key in services) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
      contents: services[args.path], resolveDir: fileURLToPath(new URL('..', import.meta.url))
    }))
  } }]
})

const turn = () => new Promise(resolve => setImmediate(resolve))

async function fixture(t, kind = 'properties', deferLoad = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
  dom.window.IS_REACT_ACT_ENVIRONMENT = true
  const channels = []
  dom.window.MessageChannel = class extends MessageChannel {
    constructor() { super(); channels.push(this) }
  }
  let saved = 'Saved synopsis', mounted = false
  let failSave = false, saveGate = null
  const writes = []
  let releaseLoad
  const loading = deferLoad ? new Promise(resolve => { releaseLoad = resolve }) : Promise.resolve()
  dom.window.synopsisRpc = { request: async (method, args) => {
    assert.equal(args[0], 'chapter')
    assert.equal(args[1], 'scene')
    if (method === 'scenes/getMeta') { await loading; return { synopsis: saved } }
    assert.equal(method, 'scenes/setSynopsis')
    writes.push(args[2])
    if (saveGate) await saveGate
    if (failSave) throw new Error('Disk unavailable')
    saved = args[2]
  } }
  dom.window.eval(bundle.outputFiles[0].text)
  const app = dom.window.synopsisFixture
  const unmount = async () => { if (mounted) { await app.unmount(); mounted = false } }
  t.after(async () => {
    await unmount(); await app.flush(); dom.window.close()
    for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  })
  const mount = async () => {
    await app.mount(kind); mounted = true
    if (!deferLoad) await waitFor(() => dom.window.document.querySelector('#dock-synopsis:not(:disabled)'))
  }
  const input = () => dom.window.document.querySelector('#dock-synopsis')
  const type = async text => {
    input().focus()
    const prototype = input().tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input(), text)
    await app.change(() => input().dispatchEvent(new dom.window.Event('input', { bubbles: true })))
    await turn()
    assert.equal(input().value, text)
  }
  await mount()
  return { app, input, type, mount, unmount, writes, releaseLoad, get saved() { return saved },
    set saved(value) { saved = value },
    set failSave(value) { failSave = value }, set saveGate(value) { saveGate = value },
    alert: () => dom.window.document.querySelector('[role="alert"]'),
    second: () => dom.window.document.querySelector('#second-synopsis') }
}

async function waitFor(read) {
  const deadline = Date.now() + 1_000
  while (!read()) {
    assert.ok(Date.now() < deadline, 'synopsis field did not load')
    await turn()
  }
}

test('saving the workspace preserves a synopsis while its field still has focus', async t => {
  const f = await fixture(t)
  await f.type('Summary typed before closing the app')
  await f.app.flush()
  assert.equal(f.saved, 'Summary typed before closing the app')
})

test('leaving and reopening properties preserves a synopsis without a blur event', async t => {
  const f = await fixture(t)
  await f.type('Summary typed before changing views')
  await f.unmount()
  await f.app.flush()
  await f.mount()
  assert.equal(f.input().value, 'Summary typed before changing views')
})

test('a refreshed scene list cannot replace a newer synopsis draft', async t => {
  const f = await fixture(t)
  await f.type('New summary still being written')
  await f.app.refresh('Saved synopsis')
  await turn()
  assert.equal(f.input().value, 'New summary still being written')
})

test('blurring a synopsis saves its edited text', async t => {
  const f = await fixture(t)
  await f.type('Summary saved on blur')
  await f.app.change(() => f.input().blur())
  assert.equal(f.saved, 'Summary saved on blur')
})

for (const kind of ['row', 'card']) {
  test(`leaving a synopsis ${kind} preserves text without blur`, async t => {
    const f = await fixture(t, kind)
    await f.type('Summary from the manuscript')
    await f.unmount()
    await f.app.flush()
    await f.mount()
    assert.equal(f.input().value, 'Summary from the manuscript')
  })
}

test('a failed synopsis save retains the text and retries before closing', async t => {
  const f = await fixture(t)
  await f.type('Summary awaiting retry')
  f.failSave = true
  await assert.rejects(f.app.flush(), /Disk unavailable/)
  assert.equal(f.input().value, 'Summary awaiting retry')
  assert.ok(f.alert())
  f.failSave = false
  await f.app.flush()
  assert.equal(f.saved, 'Summary awaiting retry')
  assert.equal(f.alert(), null)
})

test('reopening properties during a pending save keeps the newer synopsis', async t => {
  const f = await fixture(t)
  let release
  f.saveGate = new Promise(resolve => { release = resolve })
  await f.type('Summary waiting for disk')
  await f.unmount()
  await f.mount()
  assert.equal(f.input().value, 'Summary waiting for disk')
  await f.type('Newer summary while the save is pending')
  await f.app.change(async () => { release(); await turn() })
  await f.app.flush()
  assert.equal(f.saved, 'Newer summary while the save is pending')
  assert.deepEqual(f.writes, ['Summary waiting for disk', 'Newer summary while the save is pending'])
})

test('clearing a synopsis is saved and its plain-text lists are not reformatted', async t => {
  const f = await fixture(t)
  await f.type('- An ordinary summary bullet')
  await f.app.flush()
  assert.equal(f.saved, '- An ordinary summary bullet')
  await f.type('')
  await f.app.flush()
  await f.unmount()
  await f.mount()
  assert.equal(f.input().value, '')
  assert.equal(f.saved, '')
})

test('saved synopses also update the scene list and manuscript previews', async t => {
  const f = await fixture(t)
  await f.type('Summary shown on the board')
  await f.app.flush()
  const { project, manuscript } = f.app.snapshot()
  assert.equal(project.chapters[0].scenes[0].synopsis, 'Summary shown on the board')
  assert.equal(manuscript.sections[0].scenes[0].synopsis, 'Summary shown on the board')
})

test('closing one synopsis surface during loading leaves the other editable', async t => {
  const f = await fixture(t, 'pair', true)
  await f.app.hideFirst()
  await f.app.change(async () => f.releaseLoad())
  assert.equal(f.second().disabled, false)
  assert.equal(f.second().value, 'Saved synopsis')
})

test('an untouched synopsis refreshes after an external metadata update', async t => {
  const f = await fixture(t)
  f.saved = 'Summary updated by an extension'
  await f.app.refresh('Summary updated by an extension')
  assert.equal(f.input().value, 'Summary updated by an extension')
})
