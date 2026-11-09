import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dismissTour, launchApp, seedBook } from './harness'

test('a missing saved notes position leaves Dashboard and Manuscript accessible until docking is requested', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'nl-notes-missing-position-'))
  const profile = join(workDir, 'profile')
  mkdirSync(profile)
  writeFileSync(join(profile, 'scene-notes-window.json'), JSON.stringify({ docked: true, dockVisible: true }))
  const h = await launchApp('nl-notes-missing-position-', {}, workDir)
  try {
    const book = await seedBook(h, { Opening: ['Arrival'] })
    await dismissTour(h.page)
    await h.page.evaluate(() => window.novalistStores.shell.getState().goHome())
    await expect(h.page.locator('.pane-leaf[data-view="dashboard"]')).toBeVisible()
    await expect(h.page.locator('.notes-dock-targets')).toHaveCount(0)

    const chapter = book.chapters[0]
    const prose = '<p>The arrival begins the story.</p>'
    await h.rpc('scenes/write', [chapter.guid, chapter.scenes[0].id, prose, 'The arrival begins the story.'])
    await h.page.evaluate(() => window.novalistStores.shell.getState().setMainView('manuscript'))
    const editor = h.page.frameLocator('iframe[title="manuscript"]').locator('.scene-editor')
    await expect(editor).toHaveText('The arrival begins the story.')
    await expect(h.page.locator('.notes-dock-targets')).toHaveCount(0)

    await h.page.locator('.toolbar [data-command="app.toggleSceneNotes"]').click()
    await expect(h.page.locator('.notes-dock-targets')).toBeVisible()
    await h.page.keyboard.press('Escape')
    await expect(h.page.locator('.notes-dock-targets')).toHaveCount(0)
    await editor.click()
    await expect.poll(() => h.page.evaluate(async () =>
      (await window.novalist.sceneNotesWindowState?.())?.context?.sceneId)).toBe(chapter.scenes[0].id)
    await expect(h.page.locator('.notes-dock-targets')).toHaveCount(0)
    await expect(editor).toHaveText('The arrival begins the story.')

    await h.page.locator('.toolbar [data-command="app.toggleSceneNotes"]').click()
    await h.page.getByRole('button', { name: 'Dock right', exact: true }).click()
    await expect(h.page.locator('.scene-notes-panel')).toBeVisible()
    await expect(h.page.locator('.notes-dock-targets')).toHaveCount(0)
    await expect(editor).toHaveText('The arrival begins the story.')
  } finally { await h.close() }
})
