# TopoSite — Maps (product definition)

Agreed with the user 2026-10-09. This supersedes the current "plans" UI. The
data model in `ROADMAP.md` (floor plans, rooms, panoramas, satellite) still
applies to backgrounds.

## What TopoSite is

A self-contained app that lives inside Z-Wave JS UI at `/toposite/`. It
opens on a **map** and lets you switch between maps. A map shows Z-Wave nodes
and their links, either on a background image (floor plan, photo, anything) or with
no background as a live network graph.

## Concepts

### Background

A reusable picture that maps are drawn on: an uploaded PNG, JPEG or WebP the
user creates elsewhere (a floor plan export, satellite screenshot, photo),
with an optional **dark-mode version** shown while Z-Wave JS UI is dark.
TopoSite has no drawing tools (user, 2026-10-10).

A background has a size in pixels, an optional scale (`metersPerPixel`), and
later a georef. It belongs to no particular map, and any number of maps can
use it. Deleting a background is refused while a map still uses it.

### Map

A named, saved view. It has:

- **A background**, or *none*, which means the live graph layout.
- **Node positions**, stored **per map**, in the background's pixels. Two
  maps on the same background can place a node in different spots.
- **A node list**: a starting rule (**include all** or **exclude all**) plus
  per-node **exceptions**. Shown nodes are the starting rule with the
  exceptions flipped. The rule also decides what happens to nodes added to
  Z-Wave later: on an include-all map they appear, on an exclude-all map they
  stay hidden.
- **View settings**: the saved zoom and centre, and which layers are on
  (routes, backup routes, neighbors).

### Default map

One map is marked as the default and opens when TopoSite loads. Until the
user picks one, the default is the built-in **Network Graph** map.

### Network Graph (built in)

- No background and nothing to place: nodes are laid out live, like Z-Wave JS
  UI's mesh graph. The controller sits in the middle and nodes are pulled
  together along their routes. Shapes and colors follow `CLAUDE.md`.
- It can't be deleted or renamed. It has its own node list and view settings.

## Rendering rules

- **Shown nodes** draw at their position on the map. A shown node with **no
  position** waits in the **unplaced tray** (see the UI section) instead of
  being dropped somewhere on the map.
- **Hidden nodes** don't draw. The exception: when a hidden node is a
  **repeater on a shown node's route** (LWR, or NLWR when that layer is on),
  it draws as a small grey **ghost** dot at its position on this map, so the
  route stays traceable. A ghost with no position on this map is placed
  midway between its route neighbors, flagged as approximate.
- **Links**: route segments are drawn when both ends are shown or ghosted.
  Neighbor lines are drawn only between shown nodes.
- Mesh-health styling is unchanged and still to be decided by eye.

## UI

The layout should feel like an app, not a debug page.

- **Top bar**:
  - the map picker, with the default map marked
  - **Edit**: a view/edit toggle; the map is read-only in view mode
  - **Refresh neighbors**
  - the summary (nodes, dead/failed, neighbors known)
- **Right-hand pane** (user, 2026-10-10): resizable by dragging its left edge
  or with ← → on the handle. Its contents are sized in em and scale with the
  pane's width, and the width is remembered per browser. It holds the controls
  and the legend, and in future the sections below.
- **Layers…** button on the map's top right (Google Maps style): opens toggles
  for routes, backup routes, neighbors and nodes.
- **Pane controls (user, 2026-10-10), as built today:**
  - **Map** drop-down: the current map.
  - **Map ▾**: New… · Rename… · Delete (two clicks) · Export · Import….
    Export/import are built on today's plans (2026-10-10); node lists join
    the file format when maps get them.
  - **Background ▾**: Set image… · Set dark-mode image… · Unset (two clicks).
  - **Refresh neighbors**.
  - **Legend**: toggle, starts hidden.
- **Pane sections (later steps):**
  - **Maps**: list, **New map…**, rename, **Set as default**, delete (two
    clicks).
  - **Nodes** (edit mode): every node with a show/hide checkbox for this map.
    Quick selects (*all battery*, *all mains*, *by Z-Wave JS UI location*,
    *none*, *all*) set the exceptions in one go, and the list can be filtered
    by name.
  - **Unplaced tray** (edit mode): shown nodes with no position on this map.
    Drag them onto the map.
  - **Background** (edit mode): pick from the library, upload an image (and its dark version),
    remove. Changing the background asks whether to keep the node positions
    (same-sized replacement) or clear them.
- **Map area**: background, links, nodes, legend. In edit mode nodes can be
  dragged.
- **Node menu (right-click):** it never acts on its own (user, 2026-10-10:
  "way too easy"). It opens a menu, and nothing changes until an item is
  clicked. It holds actions only: details stay on the hover tooltip, which
  closes while the menu is open. A node with no actions available shows a
  one-line hint (for example "drag it onto the plan").
  - **Unplace:** back to the tray; edit mode only.
  - **Hide on this map:** edit mode only.
  - **Link to… / Delete:** on placeholders; edit mode only.

**New map…** asks for:

- name
- background: none (live graph), an existing background, upload an image, or

- starting rule: include all / exclude all
- optional **copy positions from** another map, a one-time copy after which
  the two maps are independent; only offered when both maps use the same
  background

## Data model (stored in `<store>/toposite/layout.json`)

```
version: 2
settings:    { defaultMapId }
backgrounds: [{ id, name, image, imageDark?, imageRect, widthPx, heightPx,
                metersPerPixel?, elevationM, georef? }]
maps:        [{ id, name, backgroundId | null,
                nodes: { start: include|exclude, exceptions: [deviceKey] },
                view: { center, zoom, layers } }]
placements:  [{ mapId, deviceKey | null, x, y, seen: { name, deviceId, dsk? },
                placeholder?: { name, loc, deviceId, productLabel } }]
```

- The built-in Network Graph map is stored like any other map, with
  `backgroundId: null` and `builtin: true`, so its node list and view are saved.
- **Resizing** or **padding** a background moves the positions of **every map
  that uses it**, the same way `padTop` works today.
- `deviceKey` stays `zwave:<homeId>:<nodeId>`.

### Migration from version 1 (today's plans)

- Each plan becomes a **background** with the same id, size, image,
  imageRect and scale. Plans without an image get no background (their maps use the live graph). Legacy `shapes` are dropped.
- Each plan also becomes a **map** with the same name, using that background,
  rule *include all*, no exceptions.
- Placements move from `planId` to the new map's id, coordinates unchanged.
- `defaultMapId` is the map migrated from the plan named **House** if there
  is one, otherwise the Network Graph.
- The migration runs once, on first load of a v1 file. A copy of the old file
  is kept as `layout.v1.json`.

## API (sketch)

- **`/api/backgrounds`**:
  - `GET`, `POST` (image), `PATCH :id` (name, size, pad,
    scale)
  - `PUT|DELETE :id/image[?variant=dark]`
  - `DELETE :id`: 409 while a map uses it
- **`/api/maps`**:
  - `GET`, `POST` (with optional `copyPositionsFrom`)
  - `PATCH :id` (name, background, node rule and exceptions, view)
  - `DELETE :id`
- **`/api/maps/:id/placements`**: `PUT` and `DELETE`.
- **`/api/settings`**: `PATCH { defaultMapId }`.
- `/api/nodes` is unchanged. Filtering is done in the page, so switching maps
  doesn't refetch.

## Build order

1. **Data model and migration** (v1 → v2), with the API and tests. The page
   keeps working on the migrated House map.
2. **Maps UI**: picker, New map…, default map, view/edit mode, node list
   with quick selects, unplaced tray.
3. **Rendering rules**: filtering, ghost repeaters, link rules.
4. **Network Graph**: live layout as the built-in default.
5. **Background library**: reuse, replace with keep/clear positions,
   delete-if-unused.
6. **Import / export**: one map per file, reviewed matching, placeholders,
   repair links (see below).

## Import / export (agreed 2026-10-09)

### Export: one map per file

**Export map** on a map writes `<map name>.toposite`, a single JSON file
holding:

- **Header:** `format: "toposite-map"`, `version: 1`, `exportedAt`, and the
  source's Z-Wave home ID and TopoSite version.
- **The map:** name, node rule, view settings, and its **background** in full:
  the image (and dark version) as base64 with `imageRect`, size and scale.
  The Network Graph map exports without a background.
- **A node manifest:** one entry per node the map refers to (placed, or in its
  exceptions), with a file-local `ref` and identity:
  - `homeId`, `nodeId`
  - `name`, `loc`
  - `deviceId` (manufacturer-productType-productId), `productLabel`,
    `manufacturer`, `firmwareVersion`
  - role (listening/sleeping), `dsk` when available
- **Placements and exceptions:** these refer to the manifest by `ref`, never
  by `deviceKey`, so they can be remapped on import.

### Import: always reviewed

**Import map…** uploads a `.toposite` file. The server proposes a match for
each manifest entry against the nodes on *this* install, strongest evidence
first:

| Confidence | Evidence |
|---|---|
| **Certain** | Same `dsk`. Or same home ID and node ID **and** same `deviceId` and name. |
| **Likely** | Same name and same `deviceId` (any node ID or network). |
| **Possible** | Same `deviceId` and same location. Or same name only. |
| **None** | No candidate. |

Each local node is proposed for at most one entry: the strongest evidence
wins, and ties leave both unproposed.

The **review screen** lists **every** entry, even certain ones:

- what the file says (name, location, model, old node ID)
- the proposed local node and its confidence, in a drop-down of all local
  nodes, plus **No match — keep as placeholder**
- filters: show all / unconfirmed / no match

Nothing is created until you confirm. Confirming creates a **new** map; an
import never overwrites an existing one. If the name is already taken,
" (imported)" is added. The background is always created as a new
background. Reusing an identical existing background is a later refinement.

### Placeholders

A placement whose entry is set to "No match" is kept as a **placeholder**:

- It draws as a hollow, dashed marker labelled with the file's name and
  model ("Thermostat — not linked") at its saved spot.
- In edit mode, the node list shows placeholders. Choosing **Link to…** on
  one assigns a local node, which takes that position. **Delete** removes it.
- Placeholders have no links, are never counted as dead nodes, and don't
  appear in exports.

### Re-linking on the same install

The same matching and review screen repairs a map **on this install** when
devices change:

- Each placement stores a small **identity snapshot** (name, `deviceId`, `dsk`
  if known) when it's made.
- If the node at that key disappears, or its `deviceId` no longer matches its
  snapshot (excluded and re-included, or a node ID reused), the map shows
  **Repair links…**, which opens the review screen for just those placements.

### Size

Map files can be tens of MB with a large image. The upload is sent as raw
bytes (`Content-Type: application/x-toposite`) and read by TopoSite itself, so
Z-Wave JS UI's 5 MB `express.json` limit doesn't apply. TopoSite allows up to
40 MB.

### API additions

- `GET /api/maps/:id/export`: returns the file (`Content-Disposition:
  attachment`).
- `POST /api/import/preview`: takes the file and returns the manifest with a
  proposed match and confidence per entry, plus a `token`. The parsed file is
  held server-side for 10 minutes.
- `POST /api/import/commit`: takes `{token, matches: {ref → deviceKey |
  null}}` and creates the background and the map.
- `GET /api/maps/:id/repair`: lists placements whose node is missing or
  changed, with proposed matches. Fixes are applied with `PATCH` on the map's
  placements.

### Build order

This becomes **step 6**, after the background library. The identity snapshot
on placements goes into **step 1**, so data from now on carries it.

## Open

- **Nav tab:** whether TopoSite should appear as a tab in Z-Wave JS UI's
  sidebar when upstream #3888 (plugin UI tabs) lands.
- **DSK:** not exposed by Z-Wave JS UI yet (upstream PR #4122). Matching relies
  on `deviceId` + name + location until it is.

<!-- SN: 00001 -->
