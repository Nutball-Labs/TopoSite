// layout.test.js — Plans, placements and image checks (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Layout, sniffImage } from '../lib/layout.js'
import { resolveStoreDir } from '../lib/store.js'
import { mkdir, writeFile } from 'node:fs/promises'

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

const fresh = async () => new Layout(await mkdtemp(path.join(tmpdir(), 'toposite-layout-')))

test('only PNG, JPEG and WebP are recognized — never SVG', () => {
    assert.equal(sniffImage(PNG).ext, 'png')
    assert.equal(sniffImage(JPEG).ext, 'jpg')
    assert.equal(sniffImage(WEBP).ext, 'webp')
    assert.equal(sniffImage(SVG), null)
    assert.equal(sniffImage(Buffer.alloc(0)), null)
})

test('empty store loads an empty layout', async () => {
    const layout = await fresh()
    assert.deepEqual(await layout.load(), { version: 1, plans: [], placements: [] })
})

test('adding a plan writes the image and layout.json', async () => {
    const layout = await fresh()
    const plan = await layout.addPlan({ name: 'Google Earth', widthPx: 1920, heightPx: 1080, bytes: PNG })
    assert.match(plan.id, /^[0-9a-f]{8}$/)
    assert.equal(plan.image, `${plan.id}.png`)
    assert.ok(existsSync(layout.imagePath(plan)))
    const saved = JSON.parse(await readFile(layout.file, 'utf8'))
    assert.deepEqual(saved.plans, [plan])
})

test('bad uploads are refused with the right status', async () => {
    const layout = await fresh()
    await assert.rejects(layout.addPlan({ name: 'x', widthPx: 10, heightPx: 10, bytes: SVG }), { status: 415 })
    await assert.rejects(layout.addPlan({ name: 'x', widthPx: 0, heightPx: 10, bytes: PNG }), { status: 400 })
    await assert.rejects(layout.addPlan({ name: 'x', widthPx: 1.5, heightPx: 10, bytes: PNG }), { status: 400 })
    await assert.rejects(layout.addPlan({ name: 'x', widthPx: NaN, heightPx: 10, bytes: PNG }), { status: 400 })
})

test('placements: one per device, clamped to the plan, removed with their plan', async () => {
    const layout = await fresh()
    const plan = await layout.addPlan({ name: 'p', widthPx: 100, heightPx: 50, bytes: PNG })
    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 10, y: 20 })
    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 500, y: -5 })
    let saved = await layout.load()
    assert.deepEqual(saved.placements, [{ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 100, y: 0 }])

    await assert.rejects(layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:3', planId: 'nope', x: 1, y: 1 }), { status: 404 })
    await assert.rejects(layout.setPlacement({ deviceKey: '../etc', planId: plan.id, x: 1, y: 1 }), { status: 400 })
    await assert.rejects(layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:3', planId: plan.id, x: '1', y: 1 }), { status: 400 })

    await layout.removePlacement('zwave:cdfbb3c7:2')
    assert.deepEqual((await layout.load()).placements, [])

    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:4', planId: plan.id, x: 1, y: 1 })
    await layout.deletePlan(plan.id)
    saved = await layout.load()
    assert.deepEqual(saved, { version: 1, plans: [], placements: [] })
    assert.ok(!existsSync(layout.imagePath(plan)))
})

test('concurrent placements are all kept', async () => {
    const layout = await fresh()
    const plan = await layout.addPlan({ name: 'p', widthPx: 100, heightPx: 100, bytes: PNG })
    await Promise.all([2, 3, 4, 5, 6].map((id) =>
        layout.setPlacement({ deviceKey: `zwave:cdfbb3c7:${id}`, planId: plan.id, x: id, y: id })))
    assert.equal((await layout.load()).placements.length, 5)
})

test("store dir: env overrides, then <cwd>/store, then two levels above the plugin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'toposite-store-'))
    const store = path.join(root, 'store')
    await mkdir(path.join(store, 'plugins', 'toposite'), { recursive: true })
    await writeFile(path.join(store, 'settings.json'), '{}')
    const plugin = path.join(store, 'plugins', 'toposite')
    assert.equal(resolveStoreDir({}, root, '/nowhere'), store, '<cwd>/store (Docker: /usr/src/app/store)')
    assert.equal(resolveStoreDir({}, '/nowhere', plugin), store, 'plugin installed in <store>/plugins/toposite')
    assert.equal(resolveStoreDir({ STORE_DIR: store }, '/nowhere', '/nowhere'), store)
    assert.equal(resolveStoreDir({ TOPOSITE_STORE_DIR: '/nowhere' }, root, '/nowhere'), store, 'a dir without settings.json is skipped')
    assert.equal(resolveStoreDir({}, '/nowhere', '/nowhere'), null)
})

// SN: 00001
