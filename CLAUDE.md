# TopoSite — Claude Code Project Context

This file is read automatically by Claude Code at session startup.
It contains standing instructions, architecture decisions, and conventions
for working on the TopoSite project. Read this before touching any code.

---

## Project Overview

**TopoSite** is a **Z-Wave JS UI plugin** that places Z-Wave nodes on a floor
plan or other background image and draws the mesh links between them. Node
icons show at a glance whether a node is mains-powered (always listening,
repeats for the mesh) or battery-powered (sleeps, doesn't route). Link styling
shows mesh health so problems stand out: weak or one-way links, nodes with too
few neighbors, and dead or isolated nodes.
Private GitHub repo at https://github.com/Nutball-Labs/TopoSite — all work on `main` branch.

"Topo" means **topology**, not topography.

**Current version:** 0.1.0 (SN 00001) — `version` in `package.json`
**Language:** JavaScript (ES modules), Node — runs inside Z-Wave JS UI (Node ≥ 20 — the `zwavejs/zwave-js-ui` 11.24.2 Docker image ships 22.20). Requires **Z-Wave JS UI ≥ 11.6.0** (first release that loads plugins with `import()`)
**Tests:** `npm test` (Node's built-in `node:test`, no dependencies)

---

## Developer Profile

Experienced Linux sysadmin (Perl/Python/bash). Full root on Alma 9.x dev machine.
Uses VSCode + vim. Has 40+ years sysadmin experience — don't over-explain Linux
basics. JavaScript/Node idioms are where help is most useful.

---

## Naming

Final name settled 2026-10-06 after collision checks. Use these IDs everywhere:

| Context | Identifier |
|---|---|
| Display name | `TopoSite` |
| npm package / URL base | `toposite` / `/toposite/` |
| openHAB binding *(deferred)* | `org.openhab.binding.toposite` |
| pfSense package *(deferred)* | `pfSense-pkg-TopoSite` |

Plain descriptive name — not the creature-pun style of the Nutball-Labs apps
(TagGoblin, FlickImp, CamClops).

---

## Source Layout

| Path | Role |
|---|---|
| `index.js` | Plugin entry: default-export class Z-Wave JS UI constructs with `{zwave, mqtt, app, logger}`; registers routes under `/toposite/` |
| `lib/mesh.js` | **The only file that reads Z-Wave JS UI's internal `ZUINode` shape** — converts it to TopoSite's node model |
| `public/` | Map page: `index.html`, `app.js` (Leaflet + refresh button), `mesh-view.js` (pure colors/layout/route logic, tested in Node), `vendor/` (Leaflet 1.9.4, socket.io-client 4.8.4 — no SN, skipped by sn_audit) |
| `test/` | `node:test` unit tests, run with a fake plugin context |
| `ROADMAP.md` | Zoom levels (satellite → floor plan → room panorama), data model, phases |
| `scripts/sn_audit.sh` | Regenerates `sn_audit.txt` |
| `scripts/gen_line_count.sh` | Daily line-count snapshot → `Line_Counts/` |

### Plugin API (current)

| Route | Returns |
|---|---|
| `GET /toposite/` | Map page (static files from `public/`; `/toposite` redirects to `/toposite/`) |
| `GET /toposite/api/nodes` | `{success, data: [node]}` — node: `id, name, location, role (controller/listening/sleeping), isListening, isFrequentListening, isRouting, status (ok/dead/failed), neighbors[], unknownNeighbors[], lwr, nlwr` (routes: `hops, repeaters[], rssi, repeaterRSSI[], protocolDataRate, failedBetween`). Virtual nodes (broadcast 255, multicast) are skipped. RSSI is dBm, `'saturated'`, `'no-signal'` or `null` (zwave-js RssiError 126/125/127). `unknownNeighbors` = IDs in the controller's neighbor table with no node (removed nodes) |

---

## Z-Wave JS UI Plugin Facts

Checked in Z-Wave JS UI source 2026-10-06/09 and live on 11.24.2 2026-10-09 (`docs/guide/plugins.md`,
`api/lib/CustomPlugin.ts`, `api/app.ts`, `api/lib/ZwaveClient.ts`):

- Loaded with `import()` since **v11.6.0** (v11.5.x and older used `require()`
  and are not supported); must default-export a class; constructor gets
  `PluginContext {zwave, mqtt, app, logger}`; must implement `async destroy()`
  (called on shutdown **and on settings save** — remove listeners/timers there).
- Installed via **Settings → General → Plugins**: absolute path or an npm
  package name. The path must point at **`index.js`**, not the directory:
  ESM `import()` rejects directories (`ERR_UNSUPPORTED_DIR_IMPORT`), even
  though Z-Wave JS UI's docs show a directory. In Docker, put it under `store/`
  so it persists: `/usr/src/app/store/plugins/toposite/index.js`. The field is
  a chip combobox — press **Enter** before Save or nothing is saved. The logger
  module name is `path.basename()` of the entry, so log lines say `INDEX.JS`.
- Z-Wave JS UI's own log (APP lines, "Successfully loaded plugin") goes to
  `docker logs` only, and only when **Settings → General → Log enabled** is on
  (`gateway.logEnabled`). `store/logs/zwavejs_*.log` is the driver log.
- `app` is an Express router mounted at the **root** of Z-Wave JS UI's server →
  all TopoSite routes live under `/toposite/`.
- **Plugin routes run BEFORE Z-Wave JS UI's auth check** — anything TopoSite
  serves is reachable without logging in. The plugin router is also mounted
  before the session middleware, so a plugin can't reuse Z-Wave JS UI's login.
  See Known Issues.
- **Neighbors are a cache, not live data.** `node.neighbors` is empty after a
  restart and is filled only when a node is clicked in the Network Graph
  (NodePanel → `getNodeNeighbors`) or `refreshNeighbors()` runs (whole mesh,
  turns RF off briefly, max once per 60 s). The 11.24 Network Graph draws
  LWR/NLWR only and has no refresh button. LWR/NLWR are always populated.
- `refreshNeighbors`, `getNodeNeighbors` and `discoverNodeNeighbors` are in
  Z-Wave JS UI's socket.io `allowedApis`, which sits behind its own auth.
- Node data: `zwave.getNodes()` → `ZUINode[]` with `neighbors`, `isListening`,
  `isFrequentListening`, `isRouting`, `isControllerNode`, `failed`, `available`,
  `loc`, `name`, `statistics.lwr` / `statistics.nlwr` (zwave-js RouteStatistics).
- `ZUINode`/`ZwaveClient` are internals, not a stable API — keep all reads of
  them in `lib/mesh.js`.

### Upstream watch list (open Z-Wave JS UI issues/PRs, checked 2026-10-09)

| Item | Effect on TopoSite |
|---|---|
| #4722 / #4745 / PR #4747 — backend refactor (15-PR stack, draft) | Plugin loader moves to `api/runtime/AppRuntime.ts`, same `import()` + `basename` + router. `PluginContext.zwave`/`mqtt` become **optional** → `/api/nodes` returns 503 when absent. `getNodes()`, `neighbors`, `virtual`, `refreshNeighbors` and the socket `allowedApis` unchanged at stack head `9256f7e`. Re-check when it lands. |
| #4740 — normalize socket API ACKs | Error ACK shape may change; the refresh button only reads `success`/`message` |
| #3888 — plugins get a nav tab (iframe to a plugin path) | Opportunity: TopoSite in Z-Wave JS UI's sidebar once it lands |
| PR #4746 — dashboard refactor | Login still kept in `localStorage.user.token`; no impact found |
| PR #4390 / #4389 — graph moves vis-network → VueFlow | No color changes; re-check the visual language when it lands |
| PR #4805 — release binaries built as Node SEA | Unverified whether `import()` of an external plugin works in an SEA binary; Docker unaffected |
| PR #4757 — Docker image moves to Node 24 | Fine (TopoSite needs ≥ 20) |

---

## Serial Number (SN) Convention

Every source file carries a serial number comment at the bottom of the file:

```js
// SN: 00001       ← JavaScript
# SN: 00001        ← shell scripts, YAML
<!-- SN: 00001 --> ← Markdown and HTML (invisible when rendered)
```

`package.json` can't hold comments, so it carries no SN.

**Rules:**
- There is one project-wide **high-water mark** SN, currently `00001`
- When files are modified in a build/fix session, bump their SN to the
  current high-water mark
- When cutting a new release, increment the high-water mark by 1 and apply
  it to ALL files touched in that release
- Files that were NOT changed in a session keep their existing SN — do not
  bump unchanged files
- Use `^// SN:`, `^# SN:` and `^<!-- SN:` grep anchors to find/replace SNs and
  avoid false matches in comments or documentation
- Run `scripts/sn_audit.sh` to regenerate `sn_audit.txt`
- `sn_audit.sh` uses **last-match-wins** per file — intentional, prevents doc
  examples in CLAUDE.md from generating false duplicate entries. Do not change this.

**Example workflow:**
- Working on a bug fix: change the files, bump their SN to current HWM
- Cutting a release: increment HWM (e.g. 00001 → 00002), apply to all changed
  files, update `version` in `package.json`

---

## Deliverable Format

Files are edited in place and delivered via `git push origin main`.
"Cut the tarball" means: implement changes, verify `npm test` passes, bump
SNs, bump version, commit, and push.

---

## Architecture — Critical Decisions

- **Z-Wave JS UI plugin is the product** (decided 2026-10-06). The data that
  matters — neighbors, LWR/NLWR routes, per-hop RSSI, data rate — lives in
  Z-Wave JS UI, and its users span Home Assistant, openHAB (`zwavejs`
  binding) and standalone installs. Supersedes the earlier Python-core and
  openHAB-binding-first plans.
- **Z-Wave first.** Zigbee and IP layers come later.
- **One map, three layers (eventual).** Same floor plan, layers toggled
  independently: **IP | Z-Wave | Zigbee** (Leaflet overlay layers). A device
  goes on the layer of the transport it talks over; MQTT devices on Wi-Fi
  (Tasmota, ESPHome) belong on the IP layer.
- **Three zoom levels, designed in from the start** (user, 2026-10-06):
  satellite view of the property → floor plan → 360° room panorama with
  devices placed in it and links leaving through the walls. Built in the order
  floor plan → panoramas → satellite. **Full design in `ROADMAP.md` — read it
  before touching the data model or the map page.**
- **Positions are stored in floor-plan coordinates** (plan pixels + `heightM`).
  Satellite placement (per-plan georef) and panorama direction (per-room camera
  pose) are derived, never stored as the primary position. Device keys are
  namespaced: `zwave:<homeId>:<nodeId>`.
- **Leaflet** — simple (pixel) mode for floor plans; Web Mercator once a plan is
  georeferenced for the satellite level. Serve Leaflet from the plugin (no
  CDN) — many Z-Wave JS UI installs are LAN-only.
- **Layout storage:** plans, rooms, panoramas and placements as JSON in Z-Wave
  JS UI's store dir, images alongside, so they persist with Z-Wave JS UI's own
  data *(path resolution TBD)*.
- **Mesh health is core scope.** Link styling must flag problems (weak or
  one-way links, nodes with too few neighbors, dead/isolated nodes).
  Exact styling is decided after the user reviews a rendered map.
- **Node icons show power source**, following Z-Wave JS UI's visual language below.
- **License:** GPLv3 (plugin is a separate package; Z-Wave JS UI is MIT).

### Z-Wave visual language (from Z-Wave JS UI)

Taken from Z-Wave JS UI's mesh graph, `src/components/custom/ZwaveGraph.vue`
(checked 2026-10-06). Keep these mappings unless there's a reason to diverge.

**Node shape = role / power**

| Shape | Meaning | Z-Wave JS field |
|---|---|---|
| Star | Controller | controller node id |
| Hexagon | Always listening (mains) — repeats for the mesh | `isListening == true` |
| Square | Not always listening (battery, incl. FLiRS) | `isListening == false` |

**Node color = hops to controller (via last working route)**

| Color | Meaning |
|---|---|
| `#7e57c2` purple | Controller |
| `#00BCD4` cyan | Direct (1 hop) |
| `#2DCC70` green | 2 hops |
| `#F1C40F` yellow | 3 hops |
| `#E77E23` orange | 4 hops |
| `#4a148c` dark purple | 5+ hops *(TopoSite addition — Z-Wave JS UI's table stops at 4; user, 2026-10-09)* |
| `#8b0000` dark red | Failed or dead node (label prefixed `FAILED:` / `DEAD:`) |
| `#666666` gray | Unknown (no route stats) |

**Link color = data rate**

| Color | Data rate |
|---|---|
| `#8b0000` dark red | 9.6 kbit/s |
| `#F1C40F` yellow | 40 kbit/s |
| `#2DCC70` green | 100 kbit/s |
| `#3F51B5` indigo | Long Range 100 kbit/s |
| `#666666` gray | Unknown |

**Link style = route kind**

| Style | Route |
|---|---|
| Solid, thick | Last working route (LWR) |
| Dashed, thin | Next-to-last working route (NLWR) |
| Solid, thick, star marker | Application (priority) route |
| Dashed, arrow + star | Priority return route |
| Dashed, arrow | Custom return route |
| Short-dash, labeled "Failed ❌" | Failed hop between two nodes |

Link labels show RSSI per hop where known. TopoSite's own mesh-health flags
must not clash with the meanings above.

### Deferred data sources (for the Zigbee / IP layers)

- Zigbee: Zigbee2MQTT `bridge/request/networkmap` (`{"type":"raw","routes":true}`)
  — Coordinator/Router/EndDevice, per-link LQI, routes; `power_source` from
  `bridge/devices`. Possibly reachable through the plugin's `mqtt` client.
- IP: pfSense DHCP/ARP via its API plus manual placement (ARP/nmap from inside
  a Z-Wave JS UI container only sees the container's network).
- openHAB: classic `zwave` binding exposes only `zwave_neighbours` + listening
  flags; `zwavejs` binding exposes no neighbor data. An openHAB binding is
  optional/deferred — `zwavejs` binding users already run Z-Wave JS UI.

---

## Known Issues / Pending Work

- **No auth on plugin routes.** Z-Wave JS UI's login doesn't cover them. Keep
  routes read-only; before any write route (saving positions, uploading floor
  plans) add an auth check or an explicit "trusted network only" setting.
- **Forced neighbor refresh** (2026-10-09): map page button calls Z-Wave JS
  UI's authenticated socket.io `ZWAVE_API refreshNeighbors` using the browser's
  Z-Wave JS UI login (`localStorage.user.token`) — no TopoSite route. Not yet
  tested live.
- Layout storage path inside Z-Wave JS UI's store dir not yet resolved.
- Live-tested on Z-Wave JS UI 11.24.2 (wopr3, 2026-10-09): loads, `/toposite/api/nodes` returns the mesh.

---

## Git Workflow

- All work on `main` branch
- Commit after each stable version cut
- Commit message format: `"Fix/Add/Update description — TopoSite vX.Y.Z (SN NNNNN)"`
- Remote: `git@github.com:Nutball-Labs/TopoSite.git` (SSH key auth)
- After committing: `git push origin main`

---

## Phase Status

See `ROADMAP.md` for detail.

- **Phase 1 (floor-plan map, Z-Wave):** In progress — node API + read-only map page with auto-layout and neighbor refresh; floor-plan upload/placement next (needs auth)
- **Phase 2 (room panoramas):** Designed
- **Phase 3 (satellite view):** Designed
- **Later (Zigbee and IP layers):** Deferred

<!-- SN: 00001 -->
