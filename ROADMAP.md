# TopoSite — Roadmap

TopoSite's view is a single zoom from the sky down into one room:

| Zoom | Level | Shows |
|---|---|---|
| Fully out | **Satellite** | Aerial view of the property, floor plans outlined on it |
| Middle | **Floor plan** | Floor-plan image, devices placed on it, mesh links drawn between them |
| One room | **Room panorama** | 360° photo of the room, devices placed where they physically are, links leaving through the walls toward their neighbors |

All three levels are designed in from the start: the data model below stores
everything they need, so later levels add views without reworking stored data.
Built in this order: **floor plan → room panoramas → satellite**.

---

## Data Model (applies from the first release)

Positions are stored in **floor-plan coordinates**, never in screen,
geographic or panorama coordinates. Satellite placement and panorama
directions are *derived* from them through per-plan and per-room transforms.

| Object | Fields | Notes |
|---|---|---|
| **Plan** (one per floor) | `id, name, image, imageRect?, widthPx, heightPx, metersPerPixel, elevationM, georef?` | `metersPerPixel` set by calibration (user draws a line of known length). `elevationM` = floor height, for links between floors. |
| **Georef** (on a plan) | `anchor {lat, lng}` for plan pixel (0,0), `rotationDeg`, plus `metersPerPixel` | Places the plan on the satellite map. Optional; absent = no satellite level. |
| **Room** | `id, planId, name, polygon [[x,y]…], openings? [edgeIndex…], zjuiLocation?, panorama?` | Polygon in plan pixels, any size (closets, cabinets, crawlspaces too). Edges are walls unless listed in `openings` (doorless archways, not counted as walls). `zjuiLocation` matches Z-Wave JS UI's node `loc`, so nodes tagged "Kitchen" are placed into the Kitchen room by default. Once a node is placed, the room polygon containing it wins. |
| **Panorama** (on a room) | `image, cameraX, cameraY, cameraHeightM, headingDeg` | Equirectangular 360° photo. Camera position in plan pixels; `headingDeg` = plan direction at the photo's center column. |
| **Placement** (one per device) | `deviceKey, planId, x, y, heightM?, panoAdjust? {yawDeg, pitchDeg}` | 3D position = plan (x, y) + `heightM`. Continuous coordinates: precision is the plan's pixel size (e.g. 4000 px across 20 m ≈ 5 mm). Missing `heightM` defaults by device type (outlet low, switch ~1.2 m, sensor near ceiling). `panoAdjust` is a small per-panorama correction for when the photo and the plan disagree. |
| **deviceKey** | `zwave:<homeId>:<nodeId>` | Namespaced so Zigbee (`zigbee:<ieee>`) and IP (`ip:<mac>`) devices fit later. Node IDs get reused after exclude/include, so re-inclusion needs a "re-link this placement" step. |

Stored as JSON in Z-Wave JS UI's store dir: `<store>/toposite/layout.json`, images in `<store>/toposite/images/`.

---

## Phase 1 — Floor-Plan Map (current)

- Leaflet map page served by the plugin under `/toposite/`, Leaflet bundled (no CDN).
- Upload a floor plan per floor; calibrate scale; drag nodes into place.
- Draw room polygons; auto-assign nodes by Z-Wave JS UI location.
- Z-Wave JS UI visual language for nodes and links (see CLAUDE.md).
- Mesh-health flags — styling settled after the user reviews a rendered map.
- Labels and RSSI shown only past a zoom threshold or on hover, to avoid clutter.
- **Prerequisite (done 2026-10-09):** auth check before any write route — TopoSite accepts exactly the logins Z-Wave JS UI accepts.
- *Done:* background image upload (PNG/JPEG/WebP) and drag-to-place, saved server-side.
- *Done:* simple floor-plan drawing (rectangles, circles, lines, labels) on a blank plan or over an image — added because satellite screenshots don't zoom in far enough (user, 2026-10-09). Shapes are stored per plan; room polygons (data model above) are still to come.

## Phase 2 — Room Panoramas

- Upload one 360° photo per room (phone panorama mode or a 360 camera; ~10–30 MB each).
  Viewer: Photo Sphere Viewer or Pannellum (both MIT, both support markers) — pick one when Phase 2 starts.
- Mark the camera position and facing direction on the floor plan. TopoSite then
  computes each device's direction (yaw) in the photo from its plan position.
- The photo carries no depth: the user drags each device marker up/down onto the
  real device once. Pitch + known horizontal distance gives the device's
  `heightM`, which feeds every other view.
- **Entering a room:** when a room fills the view, show an "enter room" button
  (or double-click the room). Not an automatic zoom-threshold switch, which
  flips back and forth at the boundary. Zooming fully out of a panorama returns
  to the floor plan.

### Devices in rooms without a panorama

Small spaces (e.g. a Z-Wave outlet in the closet between the living room and
the guest bedroom) won't get their own 360° photo. A panorama shows its own
room's devices normally, **plus** devices in nearby rooms that have no
panorama, drawn as "behind this wall" markers at their true direction
("Closet · Z-Wave Outlet"). Their links are drawn from there. Their height can
be adjusted from any panorama that shows them.

### Links in the panorama

Each link is the straight 3D line between the two devices, projected onto the
panorama sphere (it renders as a great-circle arc).

1. **Inside the room:** solid line from the device to where the link meets a wall,
   styled like the floor plan (color = data rate, solid/dashed = LWR/NLWR, RSSI label).
2. **At the wall:** an exit marker with the neighbor's name and room plus the number
   of walls crossed, e.g. "→ Hallway: Front Door Lock · 2 walls". Wall count =
   intersections with room-polygon edges, shared walls counted once.
3. **Beyond the wall:** faded dotted continuation to a "ghost" icon of the
   neighbor at its true direction, shrunk by distance and labeled with room
   and distance. Ghosts only show on hover/selection; by default only the stubs.
- **Other floors:** line runs through ceiling/floor using plan `elevationM`; marker reads "↑ Upstairs".
- **Route walking:** clicking an exit marker opens the neighbor's room panorama,
  turned to face back along the link, so a route can be followed hop by hop to the controller.
- **Default shows routes (LWR) only**; all neighbor links are a toggle.
- **Honesty note in the UI:** links are line-of-sight geometry, not measured radio paths.

## Phase 3 — Satellite View

- Satellite tile layer at full zoom-out. Provider configurable: Esri World Imagery,
  Mapbox, Bing. **Google tiles can't be used directly in Leaflet** (terms of service
  require Google's own map component with a billed API key).
- Requires internet. LAN-only installs fall back to a user-uploaded aerial photo.
- Georeference each plan by dragging, rotating and scaling it over the satellite image once.
- Map uses Leaflet's simple (pixel) mode when no plan is georeferenced, and Web
  Mercator when one is. Stored positions are plan-local either way.

## Later — More Layers

- Zigbee layer (Zigbee2MQTT network map) and IP layer (pfSense DHCP/ARP + manual),
  each toggled independently on the same map and in panoramas.

<!-- SN: 00001 -->
