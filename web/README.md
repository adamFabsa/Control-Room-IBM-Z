# CONTROL ROOM: URI · game screens (Part 1B)

The browser game: a live 3D Dallas County in a winter storm, plus the three screens (Get ready, Storm, How you did). Built with React, TypeScript, Vite and three.js. The game state comes from the FastAPI server on IBM LinuxONE over a WebSocket.

## Run it

```sh
cd web
npm install
npm run dev            # http://localhost:5173 (uses the built-in mock game)
```

- **Against the LinuxONE server:** set `VITE_WS_URL=ws://<vm>:8000/ws` in `web/.env` and add `?mock=0` to the URL.
- **Served by the server:** `npm run build` writes `web/dist`. The FastAPI container serves it at `/` and the page connects to `/ws` on the same host.

### URL options for testing and filming

| Option | What it does |
|---|---|
| `?mock=1` / `?mock=0` | Force the mock game, or force the server connection |
| `?phase=ready` | Start in Get ready (mock) |
| `?t=7` | Mock start time, in hours after Sun 14 Feb 18:00 |
| `?cut=C-13,C-08&dark=3` | Mock: start with these neighborhoods dark for 3 hours |
| `?sel=C-13` | Open with a neighborhood card |
| `?rot=1` | Open in another of the 4 camera rotations |
| `?q=low` | Lower quality: no shadows or bloom, less snow |
| `?cam=23.3,24,7` | Open the camera on a spot: x, z in map units (0.6 mi each) and zoom (1 = whole county, up to 400 = street level) |
| `?pr=2` | Lock the render resolution (otherwise it adapts to the GPU) |
| `?guide=1` | Show the three-step first-play guide again (it shows once by itself) |

### Controls

| Keys | Action |
|---|---|
| `Space` | Pause / play |
| `1`–`5` | Speed (1 is slowest) |
| `C` / `R` / `G` | Cut / Restore / Emergency |
| `[` `]` | Change how long a cut lasts |
| `Q` / `E` | Rotate the camera |
| `+` / `−` | Zoom |
| `↑` `↓` `Enter` | Choose on a decision card |
| `Esc` | Back to inspect |
| `H` | Hide all panels (for video shots) |
| `M` | Sound on / off |

You can also drag to pan, scroll to zoom and double-click to zoom in on a block. Pointing at a neighborhood shows a card with its state and what a click will do.

## How it's built

| Path | What it holds |
|---|---|
| `src/contracts.ts` | The shared state, action and report shapes |
| `src/link/` | The WebSocket link, plus a mock game that follows the spec's Game numbers so the screens work without the server |
| `src/map/layout.ts` | The 15 circuits and critical buildings, read from the generated real-county data |
| `tools/prep-dallas.mjs` | Turns the Census downloads into game data (see below) |
| `tools/fetch-osm.mjs`, `tools/prep-buildings.mjs` | Download every real building outline in the county from OpenStreetMap, fill the gaps and add heights from Microsoft's building footprints, and pack them for the game |
| `src/map3d/` | The three.js county |

How `src/map3d/` works:
- `ground.ts` paints the county floor from the real data into one texture. It uses tract density for built-up land, airports with runways, campuses, creek green belts, the Trinity floodplain, all 56,000 street segments and the footprint of every building (so the city has its real grain from afar). It also paints a second texture: the city's streets glowing at night. Each neighborhood's plate shows its own part of that glow, so a cut neighborhood goes dark inside its real outline.
- `buildings.ts` draws all ~735,000 real buildings at true size:
  - Simple ones are boxes with hip, gable or flat roofs, drawn instanced straight from 16-byte records (the shader unpacks position, size, height, roof and style). Large irregular ones (towers, campus halls, malls) keep their real outline.
  - Colors follow what they are: brick, stone and siding houses with shingle roofs, white membrane roofs on warehouses, red brick and slate at SMU, glass towers downtown.
  - Windows are cut into the walls by the shader per floor and bay, with trim, mullions and sills; at night their lights run on the GPU from one value per neighborhood, so a cut ripples out window by window from where power feeds the neighborhood. Far away, windows merge into bigger lit blocks instead of blurring.
  - Up close: front doors, garage doors and porch lights face the nearest street; shops have storefront glass and a sign band; warehouses have roll-up loading doors; apartments and offices have floor lines; pitched roofs have eaves and shingle courses; flat roofs have a parapet, membrane seams, AC units and stair penthouses; some houses have chimneys.
  - Big buildings are always drawn. Houses and trees grow in as you zoom closer (from afar the painted footprints show them), in 4×4-unit chunks so only what's on screen is drawn.
  - Trees have trunks; live oaks and cedars stay green, the rest are bare, twiggy February crowns, snow-capped in the storm.
- `World.ts` adds the rest:
  - the critical buildings, landmarks, the power plant and freeway traffic
  - every local street as real geometry with sidewalks (crisp at street level), dark with its neighborhood
  - chimney smoke and streetlights
  - walkers to the warming center and thought bubbles over cold homes
  - day/night lighting with bloom and a storm-cloud backdrop
  - shadows that follow the view and only redraw when it moves
  - FXAA, and a resolution that adapts to the GPU
- `snow.ts` is screen-space snowfall in depth layers. It falls only when it snowed during Uri (the `weather.snow` field).
- **Cuts and cold:** a cut sweeps out from where power feeds the neighborhood, house by house, and the night glow of its streets follows. As homes drop below about 55°F, frost creeps in from the neighborhood's edges.
- **Daylight:** it follows Dallas's real sunrise and sunset during the storm (about 7:12 AM and 6:15 PM) from `src/sky.ts`, with a warm glow at dawn and dusk.
- **Landmarks:** Reunion Tower, Bank of America Plaza's green outline at night (traced on its real footprint), Dallas Hall's dome and porch at SMU, the Margaret Hunt Hill Bridge, and Fair Park's Texas Star and Cotton Bowl. Campuses (SMU, UT Dallas, UT Southwestern, Paul Quinn, UNT Dallas, Dallas College and more) and landmarks are labeled on the map.

`src/audio/` makes every sound in code with the Web Audio API: wind that follows the snowfall, a relay clunk and power-down hum on a cut, a chime on a restore, a bell for decisions and soft UI ticks. No sound files.
- The camera is an orthographic rig at the 2:1 angle.

The panels in `src/panels/` and `src/screens/` are React. The status markers and labels in `src/map/MapOverlay.tsx` are an HTML layer that follows the 3D camera.

## The real Dallas County map

The map is real Dallas County: its outline, the 645 census tracts, every street, the interstates and highways, the lakes, the Trinity River, Love Field and the other airports. It's drawn at 1 world unit = 0.6 miles; zoom all the way in and you're at street level.

**Buildings:** about 735,000, at their real place, size and orientation: the ~660,000 OpenStreetMap has in the county, plus ~74,000 from Microsoft's building footprints where OpenStreetMap had none.
- Heights are real where they're mapped (all of downtown: Bank of America Plaza 281 m, Renaissance Tower 270 m…). Almost everywhere else (~600,000 buildings) they come from Microsoft's measured height estimates, so one- and two-story houses are told apart. The rest get typical Dallas heights.
- Heights are drawn 1.5× so they read from the 30° camera.
- Buildings inside a campus (from OpenStreetMap's campus areas) are drawn as campus halls; SMU's are red brick with slate roofs.

**Trees:** about 250,000, in yards (thicker in some neighborhoods than others), in the mapped woods (the Great Trinity Forest), along the creeks and the Trinity, and in parks.

**Circuits:**
- The 15 circuits are groups of tracts grown outward from the real neighborhoods the spec names, so each circuit is one connected piece around its neighborhood and Downtown holds the skyline.
- Each circuit's real population matches the spec's number to within 8%; a little imbalance keeps every circuit compact around its own neighborhood.
- Many circuits reach into the suburbs to make the totals work. For example, the Oak Cliff circuits take in parts of Grand Prairie and Irving.
- The CDC vulnerability of each circuit is the population-weighted average over its tracts.

To rebuild the data:

```sh
mkdir -p ../data/geo && cd ../data/geo
B=https://www2.census.gov/geo/tiger
curl -O $B/GENZ2023/shp/cb_2023_us_county_500k.zip       # unzip into county/
curl -O $B/TIGER2024/TRACT/tl_2024_48_tract.zip           # unzip into tracts/
curl -O $B/TIGER2024/ROADS/tl_2024_48113_roads.zip        # unzip into roads/
curl -O $B/TIGER2024/AREAWATER/tl_2024_48113_areawater.zip   # unzip into areawater/
curl -O $B/TIGER2024/LINEARWATER/tl_2024_48113_linearwater.zip  # unzip into linearwater/
curl -O $B/TIGER2024/AREALM/tl_2024_48_arealm.zip         # unzip into arealm/ (airports, parks, campuses)
curl -o svi_tx.csv https://svi.cdc.gov/Documents/Data/2022/csv/states/Texas.csv
cd ../../web && node tools/prep-dallas.mjs
node tools/fetch-osm.mjs        # ~36 Overpass queries, ~500 MB into ../data/osm (skips what it has)
# Microsoft Global ML Building Footprints, the four Dallas County tiles (quadkeys 023112321, 023112323, 023112330,
# 023112332): find their URLs in https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv
# and save them as ../data/msbuildings/*.csv.gz
node tools/prep-buildings.mjs   # rects.bin, polys.bin, trees.bin, buildings.json; campus and landmark labels
```

## Open-source libraries and assets

| Name | License | Link |
|---|---|---|
| React, React DOM | MIT | https://react.dev |
| three.js | MIT | https://threejs.org |
| Vite, @vitejs/plugin-react | MIT | https://vite.dev |
| TypeScript | Apache-2.0 | https://www.typescriptlang.org |
| zustand | MIT | https://github.com/pmndrs/zustand |
| lucide-react | ISC | https://lucide.dev |
| IBM Plex Sans / Mono via @fontsource | OFL-1.1 | https://github.com/IBM/plex |
| Vitest | MIT | https://vitest.dev |
| Kenney City Kit (Industrial): power plant, stacks, tanks, water tower | CC0 | https://kenney.nl/assets/city-kit-industrial |
| Kenney Car Kit | CC0 | https://kenney.nl/assets/car-kit |
| shapefile (data prep only) | BSD-3-Clause | https://github.com/mbostock/shapefile |
| US Census TIGER/Line 2024 and cartographic boundaries 2023 (county, tracts, roads, water, area landmarks) | Public domain | https://www.census.gov/geographies/mapping-files.html |
| CDC/ATSDR Social Vulnerability Index 2022 (Texas, tract level) | Public data | https://www.atsdr.cdc.gov/place-health/php/svi/ |
| OpenStreetMap: building outlines, heights and types; campus, stadium and woodland areas (via the Overpass API) | ODbL 1.0, © OpenStreetMap contributors | https://www.openstreetmap.org/copyright |
| Microsoft Global ML Building Footprints: outlines missing from OpenStreetMap, and height estimates | ODbL 1.0 | https://github.com/microsoft/GlobalMLBuildingFootprints |

All game code in this folder was written during the event.
