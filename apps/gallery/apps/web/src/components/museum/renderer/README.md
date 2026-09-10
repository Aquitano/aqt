# Museum renderer

The walkable 3D museum behind `/museum/<kind>/<slug>` and the private
collection view, built on three.js and React Three Fiber. React renders only
the 2D chrome (enter overlay, HUD, minimap, tour overlay, inspect panel); the
simulation lives in `player-rig.tsx` and the scene in `scene.tsx`.

## Layout

`@aqt/gallery-layout` turns a gallery payload into a `WorldLayout`:
rooms tiled on a grid whose visiting order snakes through it, one shared wall
with a centred doorway between consecutive rooms, over-full auto rooms split
into wings, paintings spread along door-free wall spans. The same function
feeds the renderer, the server-side pre-publish linter and the studio's wall
editor and floor-plan preview, so what the curator is warned about is exactly
what the visitor sees.

## Performance budget

Target: 100 artworks across 25 rooms at 60 fps on an integrated GPU. The
design keeps per-frame cost independent of museum size.

| Concern        | Mechanism                                                                                                                                                                                                                                                                                               | Where                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Draw calls     | Every repeated part (walls, floors, ceilings, coves, doorframes, benches, frames, lips, decals, plaques, housings) is one `InstancedMesh`; plaque text is one merged geometry over a canvas atlas. Only canvases are individual meshes.                                                                 | `architecture.ts`, `instanced.tsx`, `paintings.tsx`, `text-atlas.ts` |
| Lights         | Fixed pool of at most 6 accent spotlights driven to the nearest paintings in the current room window, plus exactly one shadow-casting room light. The visible light count never changes, so shaders never recompile mid-walk.                                                                           | `lights.tsx`                                                         |
| Shadows        | `shadowMap.autoUpdate` is off; the map is re-baked only when the room light moves (room change).                                                                                                                                                                                                        | `lights.tsx`, `museum-experience.tsx`                                |
| Fill rate      | Fog at 40 m, camera far plane at 46 m, device pixel ratio capped at 1.5.                                                                                                                                                                                                                                | `constants.ts`, `museum-experience.tsx`                              |
| Textures       | Ladder of thumb (480), mid (1024) and full (2048) WebP. Thumbs within two rooms, mid within 14 m with hysteresis at 18 m, full only while hovered or inspected (max 3 resident). Byte budget with farthest-first eviction, `ImageBitmapLoader` decode off the main thread, mipmaps generated on upload. | `texture-streamer.ts`, `content.ts`                                  |
| Frame loop     | `frameloop="demand"`: frames are requested only while walking, touring or animating, capped at 60 fps. Idle scenes cost nothing.                                                                                                                                                                        | `player-rig.tsx`                                                     |
| Per-frame work | Hover picking, collision and light selection are windowed to the current room and its door neighbours and allocate nothing. Hit testing is a ray-vs-rectangle test in the layout package, so there are no hit meshes.                                                                                   | `player-rig.tsx`, `room-window.ts`                                   |

## Dev harness

`/dev/harness` renders a synthetic museum without a database:

```
/dev/harness?rooms=25&works=100&auto=1            # 5x5 grid, autopilot at the spawn
/dev/harness?rooms=6&works=24&curated=1           # every third work pinned to a wall
/dev/harness?rooms=25&works=100&auto=1&x=0&z=18&yaw=-1.5708
```

`auto=1` places the camera without pointer lock so headless screenshots show
the lit scene; `x`, `z`, `yaw` set the pose. The overlay shows fps, room and
painting counts, and the current pose. The route 404s outside dev builds.
