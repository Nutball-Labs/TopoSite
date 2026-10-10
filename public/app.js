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
        if (plan && p.planId === plan.id && p.deviceKey) placed.set(p.deviceKey, [height - p.y, p.x])
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
    drawPlaceholders(plan, height)
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

/**
 * Placeholders: imported positions whose node wasn't matched. Drawn as dashed,
 * hollow markers labelled "not linked"; right-click to Link to… a device or Delete.
 */
function drawPlaceholders(plan, height) {
    if (!plan) return
    for (const ph of state.layout.placements) {
        if (ph.planId !== plan.id || !ph.placeholder) continue
        const label = `${ph.placeholder.name ?? 'Unknown device'} — not linked`
        const marker = L.marker([height - ph.y, ph.x], {
            keyboard: false,
            icon: L.divIcon({
                className: 'ts-node ts-ph',
                iconSize: [24, 24],
                iconAnchor: [12, 12],
                html: '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /></svg>' +
                    `<span class="lbl">${esc(label)}</span>`,
            }),
        })
            .bindTooltip(`<b>${esc(label)}</b><br>${[ph.placeholder.loc, ph.placeholder.productLabel ?? ph.placeholder.deviceId]
                .filter(Boolean).map(esc).join(' · ')}<br><span class="muted">Imported position with no matching device — right-click to link it</span>`,
            { direction: 'top', offset: [0, -14] })
            .addTo(layers.nodes)
        marker.on('contextmenu', (e) => {
            L.DomEvent.preventDefault(e.originalEvent)
            openPlaceholderMenu(ph, marker, plan)
        })
    }
}

function openPlaceholderMenu(ph, marker, plan) {
    marker.closeTooltip()
    const choices = state.nodes.filter((n) => n.key && n.role !== 'controller')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((n) => `<option value="${esc(n.key)}">${esc(n.name)}${n.location ? ` — ${esc(n.location)}` : ''} (node ${n.id})</option>`)
    const div = document.createElement('div')
    div.className = 'ts-menu'
    div.innerHTML = `<div class="ts-menu-title">${esc(ph.placeholder.name ?? 'Unknown device')} <span class="muted">not linked</span></div>
        <div class="ts-menu-actions">
            <select data-act="pick" aria-label="Device to link"><option value="">Link to…</option>${choices.join('')}</select>
            <button type="button" data-act="link" disabled title="The chosen device takes this spot">Link</button>
            <button type="button" data-act="delete" title="Remove this placeholder (click twice)">Delete placeholder</button>
        </div>`
    const popup = L.popup({ closeButton: true, autoClose: true, offset: [0, -10] })
        .setLatLng(marker.getLatLng()).setContent(div).openOn(map)
    const pick = div.querySelector('[data-act="pick"]')
    const link = div.querySelector('[data-act="link"]')
    const del = div.querySelector('[data-act="delete"]')
    pick.addEventListener('change', () => { link.disabled = !pick.value })
    link.addEventListener('click', async () => {
        map.closePopup(popup)
        try {
            await api(`plans/${plan.id}/placeholders/${encodeURIComponent(ph.id)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceKey: pick.value }),
            })
            panel.setStatus(`Linked — ${esc(pick.selectedOptions[0].textContent)} now sits at that spot.`)
        } catch (error) {
            panel.setStatus(explain(error, "Couldn't link the placeholder"))
        }
        reload()
    })
    let armed = false
    del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'Really delete?'; return }
        map.closePopup(popup)
        try {
            await api(`plans/${plan.id}/placeholders/${encodeURIComponent(ph.id)}`, { method: 'DELETE' })
            panel.setStatus('Placeholder deleted.')
        } catch (error) {
            panel.setStatus(explain(error, "Couldn't delete the placeholder"))
        }
        reload()
    })
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
            await api(`plans/${plan.id}/placements/${encodeURIComponent(n.key)}`, { method: 'DELETE' })
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

// ---------------------------------------------------------------- export / import

/** Map ▸ Export: download the current map as <name>.toposite. */
async function exportMap(plan) {
    try {
        const res = await api(`plans/${plan.id}/export`, { raw: true })
        const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${plan.name}.toposite`
        const url = URL.createObjectURL(await res.blob())
        const a = Object.assign(document.createElement('a'), { href: url, download: name })
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        panel.setStatus(`Exported ${esc(plan.name)} as ${esc(name)}.`)
    } catch (error) {
        panel.setStatus(explain(error, 'Export failed'))
    }
}

/** Map ▸ Import…: upload the file for a preview, then review every node before anything is created. */
async function importPreview(file) {
    panel.setStatus(`Reading ${esc(file.name)}…`)
    try {
        const preview = await api('import/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/x-toposite' }, body: file,
        })
        panel.setStatus('')
        openReview(preview)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't read that file"))
    }
}

const CONFIDENCE = {
    certain: ['Certain', 'Same device (same network and node, or same S2 key)'],
    likely: ['Likely', 'Same name and same device model'],
    possible: ['Possible — check', 'Same model in the same location, or same name only'],
    none: ['No match', 'No device here looks like it'],
}

/** The review screen: every node in the file, its proposed match (changeable), then Import. */
function openReview(pv) {
    const overlay = document.createElement('div')
    overlay.className = 'ts-review'
    const options = (selected) => ['<option value="">No match — keep as placeholder</option>',
        ...[...pv.nodes].sort((a, b) => a.name.localeCompare(b.name)).map((n) =>
            `<option value="${esc(n.key)}"${n.key === selected ? ' selected' : ''}>${esc(n.name)}${n.location ? ` — ${esc(n.location)}` : ''} (node ${n.id})</option>`)].join('')
    const rows = pv.entries.map((e) => {
        const [label, why] = CONFIDENCE[e.confidence] ?? CONFIDENCE.none
        const detail = [e.loc, e.productLabel ?? e.deviceId, e.nodeId != null ? `was node ${e.nodeId}` : null].filter(Boolean).map(esc).join(' · ')
        return `<tr data-ref="${esc(e.ref)}" data-conf="${esc(e.confidence)}">
            <td><b>${esc(e.name ?? 'Unnamed device')}</b><div class="muted">${detail}</div></td>
            <td><select data-ref="${esc(e.ref)}" aria-label="Match for ${esc(e.name ?? e.ref)}">${options(e.key)}</select></td>
            <td><span class="ts-conf ts-conf-${esc(e.confidence)}" title="${esc(why)}">${label}</span>${e.tied
                ? `<div class="muted">${e.tied} equally good candidates — pick one</div>` : ''}</td></tr>`
    }).join('')
    const m = pv.map
    const facts = [`${m.widthPx} × ${m.heightPx} px`, m.hasImage ? 'background image' : 'no background',
        m.hasDarkImage ? 'dark-mode image' : null, pv.source?.exportedAt ? `exported ${pv.source.exportedAt.slice(0, 10)}` : null]
        .filter(Boolean).join(' · ')
    overlay.innerHTML = `<div class="ts-review-box" role="dialog" aria-modal="true" aria-labelledby="ts-review-title">
        <h2 id="ts-review-title">Import map</h2>
        <div class="muted">${esc(facts)}</div>
        <label class="ts-field"><span>New map name</span><input id="ts-review-name" maxlength="100" value="${esc(m.name)}"></label>
        <p class="muted">Check each device. Choose the matching device on this network, or keep it as a placeholder
            (a dashed marker you can link later). Nothing is created until you press Import.</p>
        <div class="ts-review-filter" role="radiogroup" aria-label="Show">
            <label><input type="radio" name="ts-rf" value="all" checked> All (${pv.entries.length})</label>
            <label><input type="radio" name="ts-rf" value="unconfirmed"> Not certain</label>
            <label><input type="radio" name="ts-rf" value="none"> No match chosen</label>
        </div>
        ${pv.entries.length
            ? `<table class="ts-review-table"><thead><tr><th>In the file</th><th>Matches on this network</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>`
            : '<p>This map has no placed nodes — only its background will be imported.</p>'}
        <div class="ts-review-warn" id="ts-review-warn" hidden></div>
        <div class="ts-review-buttons">
            <button type="button" id="ts-review-cancel">Cancel</button>
            <button type="button" id="ts-review-ok" class="ts-primary">Import</button>
        </div></div>`
    document.body.appendChild(overlay)
    const q = (sel) => overlay.querySelector(sel)
    const selects = [...overlay.querySelectorAll('select[data-ref]')]
    const ok = q('#ts-review-ok')
    const warn = q('#ts-review-warn')

    const refresh = () => {
        const counts = {}
        for (const sel of selects) if (sel.value) counts[sel.value] = (counts[sel.value] ?? 0) + 1
        let dups = 0
        for (const sel of selects) {
            const dup = !!sel.value && counts[sel.value] > 1
            sel.closest('tr').classList.toggle('ts-dup', dup)
            if (dup) dups++
        }
        const linked = selects.filter((sel) => sel.value).length
        warn.hidden = !dups
        warn.textContent = dups ? 'The same device is chosen for more than one entry — each device can only take one spot.' : ''
        ok.disabled = dups > 0
        ok.textContent = `Import (${linked} linked, ${selects.length - linked} placeholder${selects.length - linked === 1 ? '' : 's'})`
        const filter = overlay.querySelector('input[name="ts-rf"]:checked').value
        for (const tr of overlay.querySelectorAll('tbody tr')) {
            const sel = tr.querySelector('select')
            tr.hidden = (filter === 'unconfirmed' && tr.dataset.conf === 'certain') || (filter === 'none' && !!sel.value)
        }
    }
    overlay.addEventListener('change', refresh)
    refresh()

    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    q('#ts-review-cancel').addEventListener('click', close)
    ok.addEventListener('click', async () => {
        ok.disabled = true
        const matches = Object.fromEntries(selects.map((sel) => [sel.dataset.ref, sel.value || null]))
        try {
            const res = await api('import/commit', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: pv.token, matches, name: q('#ts-review-name').value.trim() || undefined }),
            })
            close()
            selectPlan(res.plan.id)
            panel.setStatus(`Imported ${esc(res.plan.name)}: ${res.linked} node${res.linked === 1 ? '' : 's'} placed` +
                (res.placeholders ? `, ${res.placeholders} placeholder${res.placeholders === 1 ? '' : 's'} to link (right-click a dashed marker).` : '.'))
        } catch (error) {
            ok.disabled = false
            warn.hidden = false
            warn.innerHTML = explain(error, 'Import failed')
        }
    })
    q('#ts-review-name').focus()
}

// ---------------------------------------------------------------- plans

/** Map ▸ New…: an empty map (grid); its first background image sets its size. */
async function newMap(name) {
    try {
        const plan = await api('plans/blank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, widthPx: 3000, heightPx: 2000 }),
        })
        selectPlan(plan.id)
        panel.setStatus(`Created map ${esc(plan.name)}. Give it a picture with Background ▸ Set image…, then drag nodes onto it.`)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't create the map"))
    }
}

/** Map ▸ Rename… */
async function renameMap(plan, name) {
    try {
        await api(`plans/${plan.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
        panel.setStatus(`Renamed to ${esc(name)}.`)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't rename the map"))
    }
    lastLayoutJSON = ''
    reload()
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
    let armedBg = null
    let nameMode = null // 'new' | 'rename' while the name box is open
    const Panel = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-panel')
            div.innerHTML = `<h1>TopoSite</h1>
                <div class="muted" id="ts-summary">Loading…</div>
                <label class="ts-field"><span>Map</span><select id="ts-plan" title="The map you're looking at"></select></label>

                <button type="button" class="ts-wide" id="ts-mapmenu" aria-expanded="false" aria-controls="ts-mapitems">Map ▾</button>
                <div class="ts-menu-items" id="ts-mapitems" hidden>
                    <button type="button" id="ts-new" title="Create a new, empty map">New…</button>
                    <button type="button" id="ts-rename" title="Rename the current map">Rename…</button>
                    <button type="button" id="ts-del" title="Delete the current map, its background and its node positions (click twice)">Delete</button>
                    <button type="button" id="ts-export" title="Download the current map (background and node positions) as a .toposite file">Export</button>
                    <button type="button" id="ts-import" title="Load a .toposite file as a new map — you review how its nodes match this network first">Import…</button>
                    <input type="file" id="ts-importfile" accept=".toposite,application/json" hidden>
                    <form class="ts-nameform" id="ts-nameform" hidden>
                        <input id="ts-name" maxlength="100" autocomplete="off" aria-label="Map name">
                        <button type="submit" id="ts-nameok">OK</button>
                        <button type="button" id="ts-namecancel">Cancel</button>
                    </form>
                </div>

                <button type="button" class="ts-wide" id="ts-bgmenu" aria-expanded="false" aria-controls="ts-bgitems"
                    title="Set or unset the current map's background image">Background ▾</button>
                <div class="ts-menu-items" id="ts-bgitems" hidden>
                    <button type="button" id="ts-bg" title="Set or replace the current map's background image — node positions stay">Set image…</button>
                    <button type="button" id="ts-bgdark" title="Set or replace the version shown while Z-Wave JS UI is in dark mode">Set dark-mode image…</button>
                    <button type="button" id="ts-bgdel" title="Remove the background images, normal and dark (click twice) — node positions stay">Unset</button>
                    <input type="file" id="ts-bgfile" accept="image/png,image/jpeg,image/webp" hidden>
                    <input type="file" id="ts-bgdarkfile" accept="image/png,image/jpeg,image/webp" hidden>
                </div>

                <button type="button" class="ts-wide" id="ts-refresh"
                    title="Asks Z-Wave JS UI to re-read every node's neighbor list from the controller. The radio pauses for a few seconds; allowed once a minute.">Refresh neighbors</button>
                <div class="muted" id="ts-status"></div>`
            L.DomEvent.disableClickPropagation(div)
            L.DomEvent.disableScrollPropagation(div)
            els = Object.fromEntries(['summary', 'plan', 'mapmenu', 'mapitems', 'new', 'rename', 'del', 'export', 'import', 'importfile',
                'nameform', 'name', 'nameok', 'namecancel', 'bgmenu', 'bgitems', 'bg', 'bgdark', 'bgdel', 'bgfile', 'bgdarkfile',
                'refresh', 'status'].map((k) => [k, div.querySelector(`#ts-${k}`)]))

            // Menu buttons open and close their item lists
            const menu = (btn, items, label) => btn.addEventListener('click', () => {
                items.hidden = !items.hidden
                btn.setAttribute('aria-expanded', !items.hidden)
                btn.textContent = `${label} ${items.hidden ? '▾' : '▴'}`
                if (items.hidden) closeName()
            })
            menu(els.mapmenu, els.mapitems, 'Map')
            menu(els.bgmenu, els.bgitems, 'Background')

            els.plan.addEventListener('change', () => selectPlan(els.plan.value))

            // New / Rename share one name box in the menu (no pop-up dialogs)
            const openName = (mode) => {
                nameMode = mode
                els.nameform.hidden = false
                els.name.value = mode === 'rename' ? (currentPlan()?.name ?? '') : ''
                els.name.placeholder = mode === 'new' ? 'Name of the new map' : 'New name'
                els.nameok.textContent = mode === 'new' ? 'Create' : 'Rename'
                els.name.focus()
                els.name.select()
            }
            const closeName = () => { nameMode = null; els.nameform.hidden = true }
            els.new.addEventListener('click', () => openName('new'))
            els.rename.addEventListener('click', () => { if (currentPlan()) openName('rename') })
            els.namecancel.addEventListener('click', closeName)
            els.name.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeName() })
            els.nameform.addEventListener('submit', (e) => {
                e.preventDefault()
                const name = els.name.value.trim()
                if (!name) return els.name.focus()
                const mode = nameMode
                closeName()
                if (mode === 'new') newMap(name)
                else if (mode === 'rename' && currentPlan()) renameMap(currentPlan(), name)
            })

            // Two clicks to delete, instead of a confirm() dialog
            els.del.addEventListener('click', () => {
                const plan = currentPlan()
                if (!plan) return
                if (armedDelete !== plan.id) {
                    armedDelete = plan.id
                    els.del.textContent = `Really delete "${plan.name}"?`
                    setTimeout(() => { armedDelete = null; els.del.textContent = 'Delete' }, 4000)
                    return
                }
                armedDelete = null
                els.del.textContent = 'Delete'
                deletePlan(plan)
            })

            // Background: set (normal / dark-mode) or unset
            els.bg.addEventListener('click', () => els.bgfile.click())
            els.bgdark.addEventListener('click', () => els.bgdarkfile.click())
            for (const [input, variant] of [[els.bgfile, 'light'], [els.bgdarkfile, 'dark']]) {
                input.addEventListener('change', () => {
                    const file = input.files[0]
                    input.value = ''
                    const plan = currentPlan()
                    if (file && plan) setBackground(plan, file, variant)
                })
            }
            els.bgdel.addEventListener('click', () => {
                const plan = currentPlan()
                if (!plan?.image && !plan?.imageDark) return
                if (armedBg !== plan.id) {
                    armedBg = plan.id
                    els.bgdel.textContent = 'Really unset the background?'
                    setTimeout(() => { armedBg = null; els.bgdel.textContent = 'Unset' }, 4000)
                    return
                }
                armedBg = null
                els.bgdel.textContent = 'Unset'
                removeBackground(plan)
            })

            els.export.addEventListener('click', () => { if (currentPlan()) exportMap(currentPlan()) })
            els.import.addEventListener('click', () => els.importfile.click())
            els.importfile.addEventListener('change', () => {
                const file = els.importfile.files[0]
                els.importfile.value = ''
                if (file) importPreview(file)
            })

            els.refresh.addEventListener('click', () => refreshNeighbors(els.refresh))
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
            const sel = plans.find((p) => p.id === selectedId)
            els.rename.disabled = !sel
            els.del.disabled = !sel
            els.export.disabled = !sel
            els.bgmenu.disabled = !sel
            els.bgdel.disabled = !(sel?.image || sel?.imageDark)
            els.plan.disabled = plans.length === 0
            // Each map keeps its own node positions — show how many, so a map with
            // none doesn't look like the positions were lost.
            const count = (id) => placements.filter((pl) => pl.planId === id && pl.deviceKey).length
            els.plan.innerHTML = plans.length
                ? plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${count(p.id)} placed)</option>`).join('')
                : '<option>No maps yet — Map ▸ New…</option>'
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
