import { expect, test, type Locator } from '@playwright/test'
import { join } from 'node:path'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'

async function addReference(group: Locator, name: string): Promise<void> {
  await group.getByRole('combobox').click()
  await group.getByRole('option', { name, exact: true }).click()
}

function referenceChip(group: Locator, name: string): Locator {
  return group.locator('.entity-chip', { hasText: name })
}

test('shared custom multiline and reference fields save through their focus leases', async () => {
  const apps: Harness[] = []
  try {
    const owner = await launchApp('nl-custom-fields-owner-')
    apps.push(owner)
    await seedBook(owner, { Chapter: ['Scene'] })
    const first = await owner.rpc<{ id: string }>('entities/create', ['character', 'Mira'])
    const second = await owner.rpc<{ id: string }>('entities/create', ['character', 'Rowan'])
    await owner.rpc('entities/saveCustomType', [{ typeKey: 'guild', displayName: 'Guild', fields: [
      { key: 'History', displayName: 'History', type: 'Text' },
      { key: 'Members', displayName: 'Members', type: 'EntityRefList', enumOptions: ['character'] }
    ] }])
    const guild = await owner.rpc<{ id: string }>('entities/create', ['guild', 'Watch'])
    await owner.rpc('collaboration/peer/host', ['127.0.0.1', 0, 'Owner'])
    const link = await owner.rpc<string>('collaboration/invite', [new Date(Date.now() + 60_000).toISOString()])
    const guest = await launchApp('nl-custom-fields-guest-')
    apps.push(guest)
    await guest.rpc('collaboration/peer/join', [link, join(guest.workDir, 'Joined'), 'Guest'])
    for (const app of apps) {
      await dismissTour(app.page)
      await app.page.evaluate(async id => {
        window.novalistStores.shell.getState().setMainView('codex')
        await window.novalistStores.codex.getState().setType('guild')
        await window.novalistStores.codex.getState().select(id)
      }, guild.id)
    }

    const ownerHistory = owner.page.getByRole('textbox', { name: 'History', exact: true })
    const guestHistory = guest.page.getByRole('textbox', { name: 'History', exact: true })
    await ownerHistory.focus()
    await expect(ownerHistory).not.toHaveAttribute('readonly')
    await guestHistory.focus()
    await expect(guestHistory).toHaveAttribute('readonly')
    await ownerHistory.fill('First line.\nSecond line.')
    await ownerHistory.blur()
    await expect(guestHistory).not.toHaveAttribute('readonly')
    await expect(guestHistory).toHaveValue('First line.\nSecond line.')
    await guestHistory.blur()

    const ownerMembers = owner.page.getByRole('group', { name: 'Members', exact: true })
    const guestMembers = guest.page.getByRole('group', { name: 'Members', exact: true })
    const ownerInput = ownerMembers.getByRole('combobox')
    const guestInput = guestMembers.getByRole('combobox')
    await ownerInput.focus()
    await expect(ownerInput).toHaveAttribute('aria-disabled', 'false')
    await guestInput.focus()
    await expect(guestInput).toHaveAttribute('aria-disabled', 'true')
    await addReference(ownerMembers, 'Mira')
    await ownerInput.blur()
    await expect(guestInput).toHaveAttribute('aria-disabled', 'false')
    await expect(referenceChip(guestMembers, 'Mira')).toBeVisible()
    await addReference(guestMembers, 'Rowan')
    await guestInput.blur()
    for (const app of apps) {
      await expect.poll(async () => (await app.rpc<{ fields: Record<string, string> }>('entities/get', ['guild', guild.id])).fields)
        .toEqual({ History: 'First line.\nSecond line.', Members: JSON.stringify([first.id, second.id]) })
    }
  } finally { for (const app of apps.reverse()) await app.close() }
})
