# TopoSite — Claude Code Project Context

This file is read automatically by Claude Code at session startup.
It contains standing instructions, architecture decisions, and conventions
for working on the TopoSite project. Read this before touching any code.

---

## Project Overview

**TopoSite** maps network and Z-Wave devices onto their physical locations —
IP devices and Z-Wave nodes placed on a floor plan or other background image,
with Z-Wave mesh-neighbor links drawn between nodes. Link styling shows mesh
health so problems are visible: weak or one-way links, nodes with too few
neighbors, and dead or isolated nodes.
Private GitHub repo at https://github.com/Nutball-Labs/TopoSite — all work on `main` branch.

"Topo" means **topology**, not topography.

**Current version:** 0.1.0 (SN 00001)
**Config dir:** `~/.config/toposite/`
**Language:** Python 3.9+ (core service) · Java (openHAB binding) · PHP (pfSense package)
**Build system:** `pyproject.toml` (setuptools) — no CMake, no C++

---

## Developer Profile

Experienced Linux sysadmin (Perl/Python/bash). Full root on Alma 9.x dev machine.
Uses VSCode + vim. Has 40+ years sysadmin experience — don't over-explain Linux
basics. Python is home turf; Java (openHAB) and PHP (pfSense) are where idiom
help is most useful.

---

## Naming

Final name settled 2026-10-06 after collision checks. Use these IDs everywhere:

| Context | Identifier |
|---|---|
| Display name | `TopoSite` |
| Python package / CLI / config dir | `toposite` |
| openHAB binding | `org.openhab.binding.toposite` |
| pfSense package | `pfSense-pkg-TopoSite` |

TopoSite ships as plugins, so it uses a plain descriptive name — not the
creature-pun style of the Nutball-Labs apps (TagGoblin, FlickImp, CamClops).

---

## Source Layout

*(No application code written yet — scaffolding phase.)*

| Path | Role |
|---|---|
| `src/toposite/__init__.py` | Package root; `__version__` (single source of truth for the version) |
| `src/toposite/` | Core service — FastAPI REST API, discovery, data store *(planned)* |
| `src/toposite/web/` | Leaflet front end for floor-plan placement *(planned)* |
| `pfsense/` | pfSense package (PHP) *(planned)* |
| `scripts/sn_audit.sh` | Regenerates `sn_audit.txt` |
| `scripts/gen_line_count.sh` | Daily line-count snapshot → `Line_Counts/` |

The **openHAB binding** does NOT live in this repo. It is built in a sparse
worktree of `openhab-addons/` created with `/template-openhab`, because it has
to build and be submitted from there.

---

## Serial Number (SN) Convention

Every source file carries a serial number comment at the bottom of the file:

```python
# SN: 00001        ← Python, shell scripts, TOML, YAML
// SN: 00001       ← Java, JavaScript, PHP (inside <?php)
<!-- SN: 00001 --> ← Markdown and HTML (invisible when rendered)
```

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
  files, update `__version__` in `src/toposite/__init__.py`

---

## Deliverable Format

Files are edited in place and delivered via `git push origin main`.
"Cut the tarball" means: implement changes, verify the package imports and
tests pass, bump SNs, bump version, commit, and push.

---

## Architecture — Critical Decisions

Decided 2026-10-06:

- **Core service in Python** — FastAPI REST API + Leaflet browser front end.
  Leaflet with `L.CRS.Simple` places icons on a user-supplied floor plan /
  background image rather than a geographic map.
- **One map, three layers.** Every device sits on the same floor plan, grouped
  into three layers the user toggles independently: **IP | Z-Wave | Zigbee**
  (Leaflet overlay layers). Any combination can be shown at once — e.g. Zigbee
  + IP together to spot weak Zigbee links near Wi-Fi APs.
- **Layer = transport.** A device goes on the layer of the network it actually
  talks over. MQTT devices running over IP (Tasmota, ESPHome, etc.) belong on
  the IP layer; MQTT only enriches them (names, model, state). Zigbee2MQTT
  devices go on the Zigbee layer even though Z2M itself is reached over MQTT.
- **Discovery, not just manual entry:**
  - IP: ARP table, DHCP leases (pfSense), nmap; MQTT discovery topics for names/details
  - Z-Wave: Z-Wave JS UI WebSocket API (full route/RSSI/data-rate stats) is the
    primary source. openHAB is a fallback: the classic `zwave` binding exposes
    `zwave_neighbours` + listening/routing flags only, and the `zwavejs` binding
    exposes no neighbor data.
  - Zigbee: Zigbee2MQTT `bridge/request/networkmap` (raw, with routes) over
    MQTT — node type Coordinator/Router/EndDevice, per-link LQI, routes;
    `power_source` from `bridge/devices`. openHAB `zigbee` binding fallback:
    `zigbee_neighbors`, `zigbee_routes`, `zigbee_powersource`.
    *(Added to scope 2026-10-06; visual language TBD after the first map is up.)*
- **Integrations:** openHAB binding (Java, via `/template-openhab`) and a
  pfSense package (PHP, in `pfsense/`).
- **Mesh health is core scope.** Neighbor-link styling must flag problems
  (weak or one-way links, nodes with too few neighbors, dead/isolated nodes).
- **Node icons show power source.** Battery vs mains must be obvious at a
  glance: mains nodes are always listening and act as repeaters; battery nodes
  sleep and don't route. This determines what each node contributes to the mesh.
- **Z-Wave map follows Z-Wave JS UI's visual language** (see below) so users
  of both tools read the same symbols the same way.

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

Link labels show RSSI per hop where known. TopoSite extends this with its own
mesh-health flags (weak/one-way links, too few neighbors) — choose those
styles so they don't clash with the meanings above.
- **check_mk dropped** — its bundled NagVis already does floor-plan maps.
- Keep the Nutball-Labs template's docs and conventions (session commands, SN
  tracking); CMake/C++ build files dropped.

---

## Hard Dependencies

| Tool/Lib | Install | Notes |
|---|---|---|
| Python 3.9+ | `python3` (Alma base) | Core service |
| FastAPI + uvicorn | `pip install -e .` | REST API / web server |
| nmap | `dnf install nmap` | Optional — active IP discovery |

---

## Known Issues / Pending Work

- Application code not yet written — scaffolding phase only
- License: core is GPLv3. Bindings merged into `openhab-addons` must be
  EPL-2.0 — decide the binding's license before submitting it.

---

## Git Workflow

- All work on `main` branch
- Commit after each stable version cut
- Commit message format: `"Fix/Add/Update description — TopoSite vX.Y.Z (SN NNNNN)"`
- Remote: `git@github.com:Nutball-Labs/TopoSite.git` (SSH key auth)
- After committing: `git push origin main`

---

## Phase Status

- **Phase 1 (core service):** Not yet started — architecture planned
- **Phase 2 (openHAB binding):** Not yet started
- **Phase 3 (pfSense package):** Not yet started

<!-- SN: 00001 -->
