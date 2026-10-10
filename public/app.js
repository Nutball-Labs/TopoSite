// app.js — TopoSite map page (Leaflet, simple/pixel CRS).
//
// Reads /toposite/api/nodes and /toposite/api/layout, shows the selected plan
// image (or a placeholder grid), and draws nodes, routes and neighbor links in
// Z-Wave JS UI's visual language. With a plan shown, nodes can be dragged into
// place; positions are saved server-side in plan pixels. Unplaced nodes use a
// temporary auto-layout and are drawn faded.
//
// Backgrounds are images the user supplies (light, and optionally a dark version).
//
// Every /toposite/api call sends Z-Wave JS UI's login token (if any); TopoSite
// accepts exactly the logins Z-Wave JS UI accepts (lib/auth.js).
//
// "Refresh neighbors" calls Z-Wave JS UI's own socket.io API (refreshNeighbors),
// which Z-Wave JS UI authenticates, rate-limits (once per 60 s) and runs with
// the radio briefly paused.

import {
    autoLayout, buildLinks, nodeColor, nodeLabel, mainRoute, rateColor, rateLabel,
    rssiLabel, HOP_LEGEND, RATE_LEGEND,
} from './mesh-view.js'

/* global L, io */

const GRID_SIZE = 1000
const POLL_MS = 30_000
const REFRESH_COOLDOWN_MS = 60_000
const PLAN_KEY = 'toposite.plan'
const PANE_KEY = 'toposite.paneWidth'
// Z-Wave JS UI's root, as the browser sees it (keeps working behind a path prefix)
const ZUI_BASE = location.pathname.replace(/toposite\/.*$/, '')
const LOGIN_LINK = `<a href="${ZUI_BASE}" target="_blank">log in to Z-Wave JS UI</a>`

const map = L.map('map', { crs: L.CRS.Simple, minZoom: -5, maxZoom: 3, zoomSnap: 0.25, attributionControl: false })

// Background images get their own pane under the overlay pane (z 400), so they
// always sit beneath route lines no matter when they're added.
map.createPane('ts-background').style.zIndex = 300

const layers = {
    background: L.layerGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    nlwr: L.layerGroup(),
    neighbors: L.layerGroup().addTo(map),
    nodes: L.layerGroup().addTo(map),
}
const LAYER_CHOICES = [
    ['Routes (last working)', layers.routes],
    ['Backup routes (next-to-last)', layers.nlwr],
    ['Neighbors (when known)', layers.neighbors],
    ['Nodes', layers.nodes],
]
addLayersButton()

const state = {
    nodes: [],
    layout: { plans: [], placements: [] },
    planId: readPref(PLAN_KEY),
    shownPlanId: undefined, // plan the view was last fitted to
    imageUrls: new Map(), // planId → {image, url}: object URL of the fetched background
    labelZoom: 0,
}

const panel = addPanel()
addLegend()
setupPane()
map.on('zoomend', applyLabelZoom)

// Theme changed (index.html): redraw so a plan's dark/light background swaps
window.addEventListener('ts-theme', () => {
    lastLayoutJSON = ''
    reload()
})

let lastNodesJSON = ''
let lastLayoutJSON = ''
reload()
setInterval(reload, POLL_MS)

// ---------------------------------------------------------------- API

/** fetch() a TopoSite API path with Z-Wave JS UI's login token. Returns `data`, throws on failure. */
async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...options.headers }
    const token = storedToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`api/${path}`, { cache: 'no-store', ...options, headers })
    if (options.raw) {
        if (!res.ok) throw await apiError(res)
        return res
    }
    const body = await res.json().catch(() => ({ success: false, message: `HTTP ${res.status}` }))
    if (!body.success) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { auth: res.status === 401 })
    return body.data
}

async function apiError(res) {
    const body = await res.json().catch(() => ({}))
    return Object.assign(new Error(body.message || `HTTP ${res.status}`), { auth: res.status === 401 })
}

function explain(error, what) {
    return error.auth
        ? `${what}: ${esc(error.message)} — ${LOGIN_LINK} in this browser, then reload.`
        : `${what}: ${esc(error.message)}`
}

async function reload() {
    try {
        const [nodes, layout] = await Promise.all([api('nodes'), api('layout')])
        const nodesJSON = JSON.stringify(nodes)
        const layoutJSON = JSON.stringify(layout)
        if (nodesJSON !== lastNodesJSON || layoutJSON !== lastLayoutJSON) {
            lastNodesJSON = nodesJSON
            lastLayoutJSON = layoutJSON
            state.nodes = nodes
            state.layout = layout
            await draw()
        }
        panel.setSummary(nodes)
        panel.setPlans(layout.plans, currentPlan()?.id, layout.placements)
    } catch (error) {
        panel.setStatus(explain(error, "Can't load the map"))
    }
}

function currentPlan() {
    const plans = state.layout.plans
    return plans.find((p) => p.id === state.planId) ?? plans[0] ?? null
}

// ---------------------------------------------------------------- rendering

async function draw() {
    const plan = currentPlan()
    const width = plan?.widthPx ?? GRID_SIZE
    const height = plan?.heightPx ?? GRID_SIZE
    const bounds = [[0, 0], [height, width]]

    // Background: plan image, or the placeholder grid
    layers.background.clearLayers()
    if (plan && (plan.image || plan.imageDark)) {
        // Dark version while the UI is dark (if there is one), otherwise the normal image
        const variant = (isDarkTheme() && plan.imageDark) || !plan.image ? 'dark' : 'light'
        const url = await planImageUrl(plan, variant).catch((error) => {
            panel.setStatus(explain(error, `Can't load image for ${esc(plan.name)}`))
            return null
        })
        // imageRect: where the picture sits, in plan px (y down); older plans: whole plan
        const r = plan.imageRect ?? { x: 0, y: 0, w: width, h: height }
        const imgBounds = [[height - (r.y + r.h), r.x], [height - r.y, r.x + r.w]]
        if (url) L.imageOverlay(url, imgBounds, { pane: 'ts-background' }).addTo(layers.background)
    } else {
        L.imageOverlay(gridImage(width, height), bounds, { opacity: 0.6, pane: 'ts-background' }).addTo(layers.background)
    }
    if (state.shownPlanId !== (plan?.id ?? null)) {
        state.shownPlanId = plan?.id ?? null
        map.fitBounds(bounds, { padding: [20, 20] })
        state.labelZoom = map.getZoom() + 0.75
        applyLabelZoom()
    }

    // Positions: saved placements on this plan, auto-layout for the rest
    const placed = new Map()
    for (const p of state.layout.placements) {
        if (plan && p.planId === plan.id) placed.set(p.deviceKey, [height - p.y, p.x])
    }
    const side = Math.min(width, height) * 0.9
    const auto = autoLayout(state.nodes, side)
    const pos = new Map()
    for (const n of state.nodes) {
        const saved = n.key && placed.get(n.key)
        if (saved) {
            pos.set(n.id, saved)
        } else {
            const [y, x] = auto.get(n.id) ?? [side / 2, side / 2]
            pos.set(n.id, [y + (height - side) / 2, x + (width - side) / 2])
        }
    }

    drawLinks(pos)
    hintOtherPlans(plan, placed)
    drawNodes(pos, plan, placed, height)
}

function drawLinks(pos) {
    for (const g of [layers.routes, layers.nlwr, layers.neighbors]) g.clearLayers()
    const byId = new Map(state.nodes.map((n) => [n.id, n]))
    const name = (id) => esc(byId.get(id)?.name ?? `NodeID ${id}`)

    for (const l of buildLinks(state.nodes)) {
        const a = pos.get(l.a)
        const b = pos.get(l.b)
        if (!a || !b) continue
        const tip = `${name(l.a)} ↔ ${name(l.b)}`
        if (l.kind === 'neighbor') {
            L.polyline([a, b], { color: '#888888', weight: 1, opacity: 0.45, interactive: false })
                .addTo(layers.neighbors)
        } else if (l.kind === 'failed') {
            L.polyline([a, b], { color: '#8b0000', weight: 1.5, dashArray: '2 4' })
                .bindTooltip(`${tip}<br>Failed ❌`, { sticky: true })
                .addTo(layers.routes)
        } else {
            const lwr = l.kind === 'lwr'
            const detail = [rssiLabel(l.rssi), rateLabel(l.rate)].filter(Boolean).join(' · ')
            L.polyline([a, b], {
                color: rateColor(l.rate),
                weight: lwr ? 4 : 1.5,
                dashArray: lwr ? null : '5 5',
                opacity: 0.85,
            })
                .bindTooltip(`${tip}<br>${detail}<br><span class="muted">route of ${l.routes.map(name).join(', ')}</span>`, { sticky: true })
                .addTo(lwr ? layers.routes : layers.nlwr)
        }
    }
}

function drawNodes(pos, plan, placed, height) {
    layers.nodes.clearLayers()
    for (const n of state.nodes) {
        const p = pos.get(n.id)
        if (!p) continue
        const isPlaced = !!(n.key && placed.has(n.key))
        const marker = L.marker(p, {
            icon: nodeIcon(n, isPlaced || !plan),
            keyboard: false,
            draggable: !!(plan && n.key),
        })
            .bindTooltip(nodeTooltip(n, plan, isPlaced), { direction: 'top', offset: [0, -14] })
            .addTo(layers.nodes)
        // Right-click opens a menu; nothing changes until a menu item is clicked
        marker.on('contextmenu', (e) => {
            L.DomEvent.preventDefault(e.originalEvent)          // no browser menu over nodes
            openNodeMenu(n, marker, plan, isPlaced)
        })

        if (!plan || !n.key) continue
        marker.on('dragend', async () => {
            const { lat, lng } = marker.getLatLng()
            try {
                await api('placements', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceKey: n.key, planId: plan.id, x: lng, y: height - lat }),
                })
                panel.setStatus(`Placed ${esc(n.name)}.`)
            } catch (error) {
                panel.setStatus(explain(error, `Couldn't save ${esc(n.name)}`))
            }
            reload()
        })
    }
}

/** On a plan with nothing placed, say where the placements are (they're per plan). */
function hintOtherPlans(plan, placed) {
    if (!plan || placed.size) return
    const elsewhere = state.layout.plans.filter((p) => p.id !== plan.id &&
        state.layout.placements.some((pl) => pl.planId === p.id))
    if (!elsewhere.length) return
    panel.setStatus(`No nodes placed on ${esc(plan.name)} yet. Positions are saved per plan — yours are on ` +
        `${elsewhere.map((p) => esc(p.name)).join(', ')}; pick it from the drop-down to see them.`)
}

/**
 * Node menu (right-click): actions only — details stay on the hover tooltip.
 * Nothing changes until an item is clicked.
 */
function openNodeMenu(n, marker, plan, isPlaced) {
    marker.closeTooltip()
    const actions = []
    if (plan && isPlaced && n.key) actions.push('<button type="button" data-act="unplace" title="Remove its saved position on this plan">Unplace</button>')
    const hint = !plan ? 'Pick a plan to place nodes.'
        : !n.key ? 'This node has no placement key yet.'
            : !isPlaced ? 'Not placed — drag it onto the plan.' : ''
    const div = document.createElement('div')
    div.className = 'ts-menu'
    div.innerHTML = `<div class="ts-menu-title">${esc(nodeLabel(n))} <span class="muted">node ${n.id}</span></div>` +
        (actions.length ? `<div class="ts-menu-actions">${actions.join('')}</div>` : `<div class="muted">${hint}</div>`)
    const popup = L.popup({ closeButton: true, autoClose: true, offset: [0, -10] })
        .setLatLng(marker.getLatLng())
        .setContent(div)
        .openOn(map)
    div.querySelector('[data-act="unplace"]')?.addEventListener('click', async () => {
        map.closePopup(popup)
        try {
            await api(`placements/${encodeURIComponent(n.key)}`, { method: 'DELETE' })
            panel.setStatus(`${esc(n.name)} unplaced — back to the automatic layout.`)
        } catch (error) {
            panel.setStatus(explain(error, `Couldn't unplace ${esc(n.name)}`))
        }
        reload()
    })
}

function nodeIcon(n, solid) {
    const color = nodeColor(n)
    const stroke = n.status === 'ok' ? '#222' : '#fff'
    let shape
    if (n.role === 'controller') {
        shape = `<polygon points="${starPoints(12, 12, 12, 5)}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`
    } else if (n.role === 'listening') {
        shape = `<polygon points="${hexPoints(12, 12, 10)}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`
    } else {
        shape = `<rect x="3" y="3" width="18" height="18" rx="2" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`
    }
    return L.divIcon({
        className: `ts-node${solid ? '' : ' ts-unplaced'}`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        html: `<svg width="24" height="24" viewBox="0 0 24 24">${shape}</svg><span class="lbl">${esc(nodeLabel(n))}</span>`,
    })
}

function nodeTooltip(n, plan, isPlaced) {
    const route = mainRoute(n)
    const lines = [`<b>${esc(nodeLabel(n))}</b> (node ${n.id})`]
    if (n.location) lines.push(esc(n.location))
    lines.push({ controller: 'Controller', listening: 'Mains — always listening', sleeping: n.isFrequentListening ? 'FLiRS (battery, wakes often)' : 'Battery — sleeps' }[n.role])
    if (route) {
        const via = route.repeaters.length ? ` via ${route.repeaters.join(' → ')}` : ' (direct)'
        lines.push(`${route.hops} hop${route.hops > 1 ? 's' : ''}${via}${n.lwr ? '' : ' — backup route only'}`)
        const r = rssiLabel(route.rssi)
        if (r) lines.push(`RSSI ${r} · ${rateLabel(route.protocolDataRate)}`)
        if (route.failedBetween) lines.push(`Failed hop: ${route.failedBetween.join(' → ')}`)
    } else if (n.role !== 'controller') {
        lines.push('No route statistics')
    }
    if (n.neighbors.length) lines.push(`Neighbors: ${n.neighbors.join(', ')}`)
    if (n.unknownNeighbors?.length) lines.push(`Stale neighbor IDs (no such node): ${n.unknownNeighbors.join(', ')}`)
    if (plan) {
        lines.push(`<span class="muted">${isPlaced ? 'Drag to move · right-click for options' : 'Not placed — drag onto the plan'}</span>`)
    }
    return lines.join('<br>')
}

function applyLabelZoom() {
    map.getContainer().classList.toggle('ts-labels', map.getZoom() >= state.labelZoom)
}

/** Plan images go through api() so the login token is sent; shown via an object URL. */
async function planImageUrl(plan, variant = 'light') {
    const key = `${plan.id}:${variant}`
    const image = variant === 'dark' ? plan.imageDark : plan.image
    const cached = state.imageUrls.get(key)
    if (cached?.image === image) return cached.url
    if (cached) URL.revokeObjectURL(cached.url)
    const res = await api(`plans/${plan.id}/image?variant=${variant}`, { raw: true, headers: { Accept: 'image/*' } })
    const url = URL.createObjectURL(await res.blob())
    state.imageUrls.set(key, { image, url })
    return url
}

/** Same rule as index.html's theme script: Z-Wave JS UI's choice, else the OS. */
function isDarkTheme() {
    const t = document.documentElement.dataset.theme
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
}

// ---------------------------------------------------------------- plans

async function uploadPlan(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        return panel.setStatus('Use a PNG, JPEG or WebP image.')
    }
    if (file.size > 25 * 1024 * 1024) {
        return panel.setStatus('That image is over 25 MB — export a smaller one.')
    }
    panel.setStatus(`Uploading ${esc(file.name)}…`)
    try {
        const bitmap = await createImageBitmap(file)
        const { width, height } = bitmap
        bitmap.close()
        const name = file.name.replace(/\.[^.]+$/, '')
        const qs = new URLSearchParams({ name, widthPx: width, heightPx: height })
        const plan = await api(`plans?${qs}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
        selectPlan(plan.id)
        panel.setStatus(`Added ${esc(plan.name)} (${width} × ${height}) as a new plan with its own node positions — ` +
            'positions on your other plans are unchanged (switch with the drop-down).')
    } catch (error) {
        panel.setStatus(explain(error, 'Upload failed'))
    }
}

function forgetImage(planId) {
    for (const variant of ['light', 'dark']) {
        const cached = state.imageUrls.get(`${planId}:${variant}`)
        if (cached) URL.revokeObjectURL(cached.url)
        state.imageUrls.delete(`${planId}:${variant}`)
    }
}

/** Set or replace the current plan's background; node positions and scale stay. */
async function setBackground(plan, file, variant = 'light') {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return panel.setStatus('Use a PNG, JPEG or WebP image.')
    if (file.size > 25 * 1024 * 1024) return panel.setStatus('That image is over 25 MB — export a smaller one.')
    panel.setStatus(`Uploading ${esc(file.name)}…`)
    try {
        const bitmap = await createImageBitmap(file)
        const qs = new URLSearchParams({ imgWidthPx: bitmap.width, imgHeightPx: bitmap.height, variant })
        bitmap.close()
        const updated = await api(`plans/${plan.id}/image?${qs}`, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
        forgetImage(plan.id)
        const which = variant === 'dark' ? 'Dark-mode background' : 'Background'
        panel.setStatus(`${which} of ${esc(plan.name)} set to ${esc(file.name)}. Node positions are unchanged.` +
            (updated.stretched ? " Its proportions don't match the plan's, so it's stretched to fit." : ''))
    } catch (error) {
        panel.setStatus(explain(error, 'Background upload failed'))
    }
    lastLayoutJSON = ''
    reload()
}

async function removeBackground(plan) {
    try {
        await api(`plans/${plan.id}/image`, { method: 'DELETE' })
        forgetImage(plan.id)
        panel.setStatus(`Removed the background of ${esc(plan.name)}. Node positions are unchanged.`)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't remove the background"))
    }
    lastLayoutJSON = ''
    reload()
}

async function deletePlan(plan) {
    try {
        await api(`plans/${plan.id}`, { method: 'DELETE' })
        forgetImage(plan.id)
        panel.setStatus(`Deleted ${esc(plan.name)} and its placements.`)
    } catch (error) {
        panel.setStatus(explain(error, 'Delete failed'))
    }
    reload()
}

function selectPlan(id) {
    state.planId = id
    writePref(PLAN_KEY, id)
    lastLayoutJSON = '' // force a redraw
    reload()
}

// ---------------------------------------------------------------- refresh neighbors

async function refreshNeighbors(button) {
    button.disabled = true
    const done = (msg, cooldown = false) => {
        panel.setStatus(msg)
        if (cooldown) setTimeout(() => { button.disabled = false }, REFRESH_COOLDOWN_MS)
        else button.disabled = false
    }

    let auth
    try {
        // Z-Wave JS UI's history fallback rewrites any GET whose Accept header contains
        // */* (plain fetch) to its SPA page; Accept starting with application/json skips it.
        const res = await fetch(`${ZUI_BASE}api/auth-enabled`, { cache: 'no-store', headers: { Accept: 'application/json' } })
        const authEnabled = (await res.json()).data === true
        if (authEnabled) {
            const token = storedToken()
            if (!token) {
                return done(`Log in to <a href="${ZUI_BASE}" target="_blank">Z-Wave JS UI</a> in this browser first, then try again.`)
            }
            auth = { token }
        }
    } catch (error) {
        return done(`Can't reach Z-Wave JS UI: ${esc(error.message)}`)
    }

    panel.setStatus('Connecting to Z-Wave JS UI…')
    const socket = io({ path: `${ZUI_BASE}socket.io`, auth, reconnection: false, timeout: 10_000 })
    try {
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve)
            socket.once('connect_error', reject)
        })
    } catch (error) {
        socket.disconnect()
        const msg = /auth/i.test(error.message)
            ? `Z-Wave JS UI refused the login — <a href="${ZUI_BASE}" target="_blank">log in again</a>, then retry.`
            : `Can't connect to Z-Wave JS UI: ${esc(error.message)}`
        return done(msg)
    }

    panel.setStatus('Reading neighbors from the controller (radio paused briefly)…')
    const result = await new Promise((resolve) => {
        socket.timeout(120_000).emit('ZWAVE_API', { api: 'refreshNeighbors', args: [] }, (err, response) => {
            resolve(err ? { success: false, message: 'timed out waiting for Z-Wave JS UI' } : response)
        })
    })
    socket.disconnect()

    if (!result?.success) return done(`Refresh failed: ${esc(result?.message ?? 'unknown error')}`, /60 seconds/.test(result?.message ?? ''))
    await reload()
    done(`Neighbors refreshed at ${new Date().toLocaleTimeString()}.`, true)
}

/** Z-Wave JS UI keeps its login (with the JWT) in localStorage 'user' (src/views/Login.vue). */
function storedToken() {
    try {
        return JSON.parse(localStorage.getItem('user') ?? 'null')?.token ?? null
    } catch {
        return null
    }
}

// ---------------------------------------------------------------- controls

function addPanel() {
    let els
    let armedDelete = null
    const Panel = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-panel')
            div.innerHTML = `<h1>TopoSite</h1>
                <div class="muted" id="ts-summary">Loading…</div>
                <div class="ts-row">
                    <select id="ts-plan" title="Background image"></select>
                    <button type="button" id="ts-add" title="Upload a PNG, JPEG or WebP image as a new plan">Add image…</button>
                    <button type="button" id="ts-del" title="Delete this background and every node position on it">Delete</button>
                    <input type="file" id="ts-file" accept="image/png,image/jpeg,image/webp" hidden>
                </div>
                <div class="ts-row">
                    <button type="button" id="ts-bg" title="Set or replace this plan's background image — node positions stay">Background…</button>
                    <button type="button" id="ts-bgdark" title="Set or replace the version of this background shown in dark mode (same position as the normal one)">Dark…</button>
                    <input type="file" id="ts-bgdarkfile" accept="image/png,image/jpeg,image/webp" hidden>
                    <button type="button" id="ts-bgdel" title="Remove this plan's background images, normal and dark (click twice) — node positions stay">✕</button>
                    <input type="file" id="ts-bgfile" accept="image/png,image/jpeg,image/webp" hidden>
                </div>
                <div class="ts-row"><button type="button" id="ts-refresh"
                    title="Asks Z-Wave JS UI to re-read every node's neighbor list from the controller. The radio pauses for a few seconds; allowed once a minute.">Refresh neighbors</button></div>
                <div class="muted" id="ts-status"></div>`
            L.DomEvent.disableClickPropagation(div)
            L.DomEvent.disableScrollPropagation(div)
            els = Object.fromEntries(['summary', 'plan', 'add', 'del', 'file', 'bg', 'bgdark', 'bgdarkfile', 'bgdel', 'bgfile', 'refresh', 'status']
                .map((k) => [k, div.querySelector(`#ts-${k}`)]))
            els.refresh.addEventListener('click', () => refreshNeighbors(els.refresh))
            els.add.addEventListener('click', () => els.file.click())
            els.bg.addEventListener('click', () => els.bgfile.click())
            els.bgdark.addEventListener('click', () => els.bgdarkfile.click())
            els.bgdarkfile.addEventListener('change', () => {
                const file = els.bgdarkfile.files[0]
                els.bgdarkfile.value = ''
                const plan = currentPlan()
                if (file && plan) setBackground(plan, file, 'dark')
            })
            els.bgfile.addEventListener('change', () => {
                const file = els.bgfile.files[0]
                els.bgfile.value = ''
                const plan = currentPlan()
                if (file && plan) setBackground(plan, file)
            })
            let armedBg = null
            els.bgdel.addEventListener('click', () => {                 // two clicks, instead of confirm()
                const plan = currentPlan()
                if (!plan?.image && !plan?.imageDark) return
                if (armedBg !== plan.id) {
                    armedBg = plan.id
                    els.bgdel.textContent = 'Remove background?'
                    setTimeout(() => { armedBg = null; els.bgdel.textContent = '✕' }, 4000)
                    return
                }
                armedBg = null
                els.bgdel.textContent = '✕'
                removeBackground(plan)
            })
            els.file.addEventListener('change', () => {
                const file = els.file.files[0]
                els.file.value = ''
                if (file) uploadPlan(file)
            })
            els.plan.addEventListener('change', () => selectPlan(els.plan.value))
            // Two clicks to delete, instead of a confirm() dialog
            els.del.addEventListener('click', () => {
                const plan = currentPlan()
                if (!plan) return
                if (armedDelete !== plan.id) {
                    armedDelete = plan.id
                    els.del.textContent = 'Really delete?'
                    setTimeout(() => { armedDelete = null; els.del.textContent = 'Delete' }, 4000)
                    return
                }
                armedDelete = null
                els.del.textContent = 'Delete'
                deletePlan(plan)
            })
            return div
        },
    })
    paneBody().appendChild(new Panel().onAdd(map))
    return {
        setStatus(html) { els.status.innerHTML = html },
        setSummary(nodes) {
            const dead = nodes.filter((n) => n.status !== 'ok').length
            const withNb = nodes.filter((n) => n.neighbors.length).length
            els.summary.textContent = `${nodes.length} nodes · ${dead} dead/failed · neighbors known for ${withNb}`
        },
        setPlans(plans, selectedId, placements = []) {
            els.plan.hidden = plans.length === 0
            els.del.hidden = plans.length === 0
            els.bg.hidden = plans.length === 0
            els.bgdark.hidden = plans.length === 0
            const sel = plans.find((p) => p.id === selectedId)
            els.bgdel.hidden = !(sel?.image || sel?.imageDark)
            // Each plan keeps its own node positions — show how many, so a plan with
            // none doesn't look like the positions were lost.
            const count = (id) => placements.filter((pl) => pl.planId === id).length
            els.plan.innerHTML = plans.map((p) =>
                `<option value="${esc(p.id)}">${esc(p.name)} (${count(p.id)} placed)</option>`).join('')
            if (selectedId) els.plan.value = selectedId
        },
    }
}

/** The right-hand pane (index.html) that holds the controls and the legend. */
function paneBody() {
    return document.getElementById('ts-pane')
}

/**
 * Resizable right-hand pane: drag the handle on its left edge (or use the arrow
 * keys on it). Everything in the pane is sized in em, and the pane's font size
 * follows its width, so the contents scale up and down with it. Width is
 * remembered per browser.
 */
function setupPane() {
    const pane = paneBody()
    const handle = document.getElementById('ts-resizer')
    const MIN = 220
    const max = () => Math.max(MIN, Math.round(window.innerWidth * 0.6))
    let width = 0
    let frame = 0
    const apply = (w) => {
        width = Math.round(Math.min(Math.max(w, MIN), max()))
        pane.style.width = `${width}px`
        pane.style.fontSize = `${Math.min(Math.max(width / 22, 11), 22).toFixed(1)}px`
        handle.setAttribute('aria-valuenow', width)
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => map.invalidateSize({ pan: false }))
    }
    apply(Number(readPref(PANE_KEY)) || 300)

    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        handle.setPointerCapture(e.pointerId)
        handle.classList.add('drag')
        const startX = e.clientX
        const startW = width
        const move = (ev) => apply(startW + (startX - ev.clientX))
        const up = () => {
            handle.classList.remove('drag')
            handle.removeEventListener('pointermove', move)
            handle.removeEventListener('pointerup', up)
            writePref(PANE_KEY, width)
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', up)
    })
    handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 50 : 10
        if (e.key === 'ArrowLeft') apply(width + step)
        else if (e.key === 'ArrowRight') apply(width - step)
        else return
        e.preventDefault()
        writePref(PANE_KEY, width)
    })
    window.addEventListener('resize', () => apply(width))
}

/** "Layers…" button on the map (Google Maps style): opens a small list of layer toggles. */
function addLayersButton() {
    const Ctl = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-layers')
            div.innerHTML = '<button type="button" class="ts-layers-btn" aria-expanded="false" ' +
                'title="Choose what\'s drawn on the map">Layers…</button><div class="ts-layers-pop" hidden></div>'
            const btn = div.querySelector('button')
            const pop = div.querySelector('.ts-layers-pop')
            const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false') }
            btn.addEventListener('click', () => {
                if (!pop.hidden) return close()
                pop.innerHTML = LAYER_CHOICES.map(([label, layer], i) =>
                    `<label><input type="checkbox" data-i="${i}"${map.hasLayer(layer) ? ' checked' : ''}> ${esc(label)}</label>`).join('')
                pop.hidden = false
                btn.setAttribute('aria-expanded', 'true')
            })
            pop.addEventListener('change', (e) => {
                const layer = LAYER_CHOICES[e.target.dataset.i]?.[1]
                if (!layer) return
                if (e.target.checked) layer.addTo(map)
                else map.removeLayer(layer)
            })
            document.addEventListener('pointerdown', (e) => { if (!div.contains(e.target)) close() })
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
            L.DomEvent.disableClickPropagation(div)
            L.DomEvent.disableScrollPropagation(div)
            return div
        },
    })
    new Ctl({ position: 'topright' }).addTo(map)
}

function addLegend() {
    const Legend = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-panel ts-legend')
            const shapes = [['★', 'Controller'], ['⬢', 'Mains (repeats)'], ['■', 'Battery (sleeps)']]
            // Always starts hidden; not remembered between visits (user, 2026-10-10)
            const open = false
            div.innerHTML = `<button type="button" class="ts-legend-toggle" aria-expanded="${open}" aria-controls="ts-legend-body"
                    title="Show or hide the legend">Legend</button>
                <div id="ts-legend-body"${open ? '' : ' hidden'}>
                <h2>Shape</h2>${shapes.map(([s, t]) => `<div><span>${s}</span>${t}</div>`).join('')}
                <h2>Node color = hops</h2>${HOP_LEGEND.map(([t, c]) => `<div><span class="sw" style="background:${c}"></span>${t}</div>`).join('')}
                <h2>Link color = data rate</h2>${RATE_LEGEND.map(([t, c]) => `<div><span class="ln" style="border-color:${c}"></span>${t}</div>`).join('')}
                <div><span class="ln" style="border-top-style:dashed;border-color:#888"></span>backup route</div>
                <div><span class="sw" style="background:#888;opacity:.45"></span>faded = not placed yet</div>
                </div>`
            const btn = div.querySelector('.ts-legend-toggle')
            const body = div.querySelector('#ts-legend-body')
            btn.addEventListener('click', () => {
                const nowOpen = body.hidden
                body.hidden = !nowOpen
                btn.setAttribute('aria-expanded', nowOpen)
            })
            return div
        },
    })
    paneBody().appendChild(new Legend().onAdd(map))
}

// ---------------------------------------------------------------- helpers

function readPref(key) {
    try { return localStorage.getItem(key) } catch { return null }
}

function writePref(key, value) {
    try { localStorage.setItem(key, value) } catch { /* private mode: not remembered */ }
}

function starPoints(cx, cy, outer, inner) {
    const pts = []
    for (let i = 0; i < 10; i++) {
        const r = i % 2 ? inner : outer
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`)
    }
    return pts.join(' ')
}

function hexPoints(cx, cy, r) {
    const pts = []
    for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3
        pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`)
    }
    return pts.join(' ')
}

/** Placeholder background for the default view and plans without an image: a light 100-px grid. */
function gridImage(width = GRID_SIZE, height = GRID_SIZE) {
    const step = 100
    let lines = ''
    for (let x = 0; x <= width; x += step) lines += `<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`
    for (let y = 0; y <= height; y += step) lines += `<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g stroke="#999" stroke-width="2" opacity="0.35">${lines}</g></svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// SN: 00001
