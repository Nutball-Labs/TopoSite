# TopoSite — Maps (product definition)

Agreed with the user 2026-10-09. This supersedes the current "plans" UI. The
data model in `ROADMAP.md` (floor plans, rooms, panoramas, satellite) still
applies to backgrounds.

## What TopoSite is

A self-contained app that lives inside Z-Wave JS UI at `/toposite/`. It
opens on a **map** and lets you switch between maps. A map shows Z-Wave nodes
and their links, either on a background (floor plan, drawing, photo) or with
no background as a live network graph.

## Concepts

### Background

A reusable picture that maps are drawn on. There are two kinds:

- **Image**: an uploaded PNG, JPEG or WebP (a floor plan export, satellite
  screenshot, photo).
- **Drawing**: walls, cabinets and labels drawn in TopoSite (or loaded from a
  shapes file), optionally with an image underneath.

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
  (routes, backup routes, neighbors, drawing).

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
- **Side panel** (collapsible):
  - **Maps**: list, **New map…**, rename, **Set as default**, delete (two
    clicks).
  - **Nodes** (edit mode): every node with a show/hide checkbox for this map.
    Quick selects (*all battery*, *all mains*, *by Z-Wave JS UI location*,
    *none*, *all*) set the exceptions in one go, and the list can be filtered
    by name.
  - **Unplaced tray** (edit mode): shown nodes with no position on this map.
    Drag them onto the map.
  - **Background** (edit mode): pick from the library, upload an image, draw,
    remove. Changing the background asks whether to keep the node positions
    (same-sized replacement) or clear them.
- **Map area**: background, links, nodes, legend. In edit mode nodes can be
  dragged (or right-clicked to unplace), and drawing tools are available when
  the background is a drawing.

**New map…** asks for:

- name
- background: none (live graph), an existing background, upload an image, or
  a new drawing
- starting rule: include all / exclude all
- optional **copy positions from** another map, a one-time copy after which
  the two maps are independent; only offered when both maps use the same
  background

## Data model (stored in `<store>/toposite/layout.json`)

```
version: 2
settings:    { defaultMapId }
backgrounds: [{ id, name, kind: image|drawing, image?, imageRect?, widthPx, heightPx,
                metersPerPixel?, elevationM, georef? }]
shapes:      [{ id, backgroundId, type, … }]        # drawings belong to the background
maps:        [{ id, name, backgroundId | null,
                nodes: { start: include|exclude, exceptions: [deviceKey] },
                view: { center, zoom, layers } }]
placements:  [{ mapId, deviceKey, x, y }]
```

- The built-in Network Graph map is stored like any other map, with
  `backgroundId: null` and `builtin: true`, so its node list and view are saved.
- **Resizing** or **padding** a background moves the positions of **every map
  that uses it**, the same way `padTop` works today.
- `deviceKey` stays `zwave:<homeId>:<nodeId>`.

### Migration from version 1 (today's plans)

- Each plan becomes a **background** with the same id, size, image,
  imageRect, scale and shapes.
- Each plan also becomes a **map** with the same name, using that background,
  rule *include all*, no exceptions.
- Placements move from `planId` to the new map's id, coordinates unchanged.
- `defaultMapId` is the map migrated from the plan named **House** if there
  is one, otherwise the Network Graph.
- The migration runs once, on first load of a v1 file. A copy of the old file
  is kept as `layout.v1.json`.

## API (sketch)

- **`/api/backgrounds`**:
  - `GET`, `POST` (image or blank drawing), `PATCH :id` (name, size, pad,
    scale)
  - `PUT|DELETE :id/image`, `PUT :id/shapes`
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

## Open

- **Nav tab:** whether TopoSite should appear as a tab in Z-Wave JS UI's
  sidebar when upstream #3888 (plugin UI tabs) lands.
- **Export / import:** of a map with its background, as one file for
  backup and sharing.

<!-- SN: 00001 -->
