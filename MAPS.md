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

A reusable picture in the library: an uploaded PNG, JPEG or WebP the user
creates elsewhere (a floor plan export, satellite screenshot, photo), with an
optional **dark-mode version** shown while Z-Wave JS UI is dark. TopoSite has
no drawing tools (user, 2026-10-10). A background records its image files and
their natural size. Where it sits is up to each map that uses it.

A background has a size in pixels, an optional scale (`metersPerPixel`), and
later a georef. It belongs to no particular map, and any number of maps can
use it. Deleting a background is refused while a map still uses it.

### Map

A named, saved view. It has:

- **A layout** (user, 2026-10-10):
  - **`placed`**: nodes sit where they've been put on the map's canvas, with
    or without a background image. This is every map except one.
  - **`graph`**: nodes are laid out live, Network Graph style. Nothing is
    placed and nothing is stored as positions. This is the built-in Network
    Graph map.
- **A canvas** (placed maps): a size in pixels, and optionally a
  **background** from the library, with where it sits on this canvas
  (`imageRect`). The same background can be framed differently on different
  maps. With no background the canvas shows a grid.
- **Node positions**, stored **inside the map** (one per device per map), in
  canvas pixels. Two maps can place a node in different spots. Deleting a map
  deletes its positions.
- **A node list**: a starting rule (**include all** or **exclude all**) plus
  per-node **exceptions**. Shown nodes are the starting rule with the
  exceptions flipped. The rule also decides what happens to nodes added to
  Z-Wave later: on an include-all map they appear, on an exclude-all map they
  stay hidden.
- **View settings**: the saved zoom and centre, and which layers are on
  (routes, backup routes, neighbors, nodes).

### Default map

One map is marked as the default and opens when TopoSite loads. Until the
user picks one, the default is the built-in **Network Graph** map.

### Network Graph (built in)

- `layout: "graph"`, no canvas and nothing to place: nodes are laid out live,
  like Z-Wave JS UI's mesh graph. The controller sits in the middle and nodes are pulled
  together along their routes. Shapes and colors follow `CLAUDE.md`.
- It can't be deleted or renamed. It has its own node list and view settings.

## Rendering rules

- **Shown nodes** draw at their position on the map (on a `placed` map) or
  wherever the live layout puts them (on the `graph` map). A shown node with **no
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
- background: none (a blank grid canvas), an existing background from the
  library, or upload an image. A new map is always `layout: "placed"`; the
  Network Graph is the only `graph` map.
- starting rule: include all / exclude all
- optional **copy positions from** another map, a one-time copy after which
  the two maps are independent; only offered when both maps use the same
  background with the same framing

## Data model (stored in `<store>/toposite/layout.json`)

Positions are nested inside their map, so one tree holds everything a map
owns (user, 2026-10-10). Live node data (names, routes, status) is never
stored; it comes from Z-Wave JS UI on every request, keyed by `deviceKey`.

```json
{
  "version": 2,
  "settings": { "defaultMapId": "a1b2c3d4" },
  "backgrounds": [
    { "id": "bg01", "name": "House floor plan",
      "image": "bg01-3f9a1c.png", "imageDark": "bg01-dark-77e0b2.png",
      "widthPx": 1500, "heightPx": 2550 }
  ],
  "maps": [
    { "id": "graph", "name": "Network Graph", "builtin": true, "layout": "graph",
      "nodes": { "start": "include", "exceptions": [] },
      "view": { "center": null, "zoom": null,
                "layers": { "routes": true, "backupRoutes": false, "neighbors": false, "nodes": true } } },

    { "id": "a1b2c3d4", "name": "Workshop sketch", "layout": "placed",
      "widthPx": 2000, "heightPx": 1500, "metersPerPixel": null,
      "background": null,
      "nodes": { "start": "include", "exceptions": ["zwave:cdfbb3c7:59"] },
      "view": { "center": [750, 1000], "zoom": -1,
                "layers": { "routes": true, "backupRoutes": false, "neighbors": true, "nodes": true } },
      "placements": [
        { "deviceKey": "zwave:cdfbb3c7:58", "x": 420, "y": 310,
          "seen": { "name": "Workshop Attic Lights", "deviceId": "99-1-1" } },
        { "deviceKey": "zwave:cdfbb3c7:68", "x": 1610, "y": 880,
          "seen": { "name": "Mini-Split", "deviceId": "271-4096-2" } },
        { "id": "ph-7f3a91c2", "deviceKey": null, "x": 980, "y": 1200,
          "placeholder": { "name": "Shop Sensor", "loc": "Workshop",
                           "deviceId": "134-2-100", "productLabel": "ZSE40" } }
      ] },

    { "id": "e5f6a7b8", "name": "House", "layout": "placed",
      "widthPx": 3000, "heightPx": 5100, "metersPerPixel": 0.006096,
      "background": { "id": "bg01", "imageRect": { "x": 0, "y": 0, "w": 3000, "h": 5100 } },
      "nodes": { "start": "include", "exceptions": [] },
      "view": { "center": null, "zoom": null, "layers": { "routes": true, "backupRoutes": false, "neighbors": false, "nodes": true } },
      "placements": [] }
  ]
}
```

**Field rules:**

- **`layout`:** `"graph"` or `"placed"`. A `graph` map has no canvas,
  `background` or `placements`. Exactly one map has `builtin: true` (the Network
  Graph): it can't be deleted or renamed, but its node list and view are saved.
- **`background`:** on a placed map, `null` (grid) or `{ id, imageRect }`. The
  `id` points into `backgrounds[]`, and `imageRect` (canvas px) is where the
  picture sits on *this* map.
- **`placements`:** one entry per device per map, in canvas px (x right, y down
  from the top-left). An entry is either a device (`deviceKey`, plus the `seen`
  identity snapshot taken when placed) or a **placeholder** (`id`, `deviceKey:
  null`, `placeholder`) from an import.
- **`nodes.exceptions`:** on an `include` map these are hidden; on an
  `exclude` map they're shown.
- **Resizing or padding** a map's canvas moves *that map's* placements and
  `imageRect` together, as `padTop` does today. Other maps using the same
  background are unaffected.
- **`deviceKey`** stays `zwave:<homeId>:<nodeId>`.
- **Deleting a background** is refused (409) while any map uses it.

### Migration from version 1

Done once on wopr3 (2026-10-10) and then removed from the code: TopoSite now
reads version 2 only and refuses any other `layout.json` without touching it.

## API (sketch)

- **`/api/backgrounds`**:
  - `GET`, `POST` (upload an image; `?variant=dark` for the dark version)
  - `PUT|DELETE :id/image[?variant=dark]`
  - `PATCH :id` (name)
  - `DELETE :id`: 409 while a map uses it
- **`/api/maps`**:
  - `GET`, `POST` (`{name, layout: "placed", widthPx?, heightPx?,
    background?, nodes, copyPositionsFrom?}`)
  - `PATCH :id`: name, background (`{id, imageRect}` or null), canvas size or
    pad, scale, node rule and exceptions, view
  - `DELETE :id`: refused for the built-in map
- **`/api/maps/:id/placements`**: `PUT {deviceKey, x, y}`, `DELETE
  :deviceKey`.
- **`/api/maps/:id/placeholders/:phId`**: `PUT {deviceKey}` (link),
  `DELETE`.
- **`/api/settings`**: `PATCH { defaultMapId }`.
- `/api/nodes` is unchanged. Filtering is done in the page, so switching maps
  doesn't refetch.

## Build order

1. **Data model and migration** (v1 → v2), with the API and tests. The page
   keeps working on the migrated House map. *Done 2026-10-10; migration
   removed after wopr3 upgraded.*
2. **Maps UI**: picker, New map…, default map, view/edit mode, node list
   with quick selects, unplaced tray. *Done 2026-10-10.* As built: the controls stay
   in the right-hand pane (no top bar) — Edit map under the picker, Set as
   default in Map ▾, the Nodes section and tray in the pane while editing. The
   default map opens on every load (the last-viewed map is no longer
   remembered). Quick selects replace the shown set; switching the starting
   rule keeps what's shown. Edit mode starts off on each visit. Saving the view
   (zoom, centre, layers) per map is not built yet.
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

- **Header:** `format: "toposite-map"`, `version: 2`, `exportedAt`, and the
  source's Z-Wave home ID and TopoSite version.
- **The map:** name, `layout`, canvas size, node rule, view settings, and its
  **background** in full (with this map's `imageRect`):
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
