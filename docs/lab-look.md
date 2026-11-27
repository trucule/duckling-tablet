# The look of Kitchen Lab and Chemistry Lab

Both labs are one minified bundle, so their look lives outside it in `tools/lab-look.js` (copied into each app as
`look.js`) and in the app's `look/` folder. The bundle makes one call, `LabLook.apply()`, between building its room and
drawing its first frame, and hands over its own three.js pieces.

What the look does:

- A photographed studio is the scene's environment. Glass, steel and liquids reflect it and it adds soft light. The
  game's sky light is turned down to match.
- Kitchen Lab's worktop, shelves and pantry use photographed oak (colour, normals, roughness).
- The wall tiles keep the colours the game draws and take their relief and gloss from a photographed tile.
- The main light is warmer and a little stronger. Chemistry Lab's wall has a blue tint and its bench is a glossy navy.
- Chemistry Lab's bench carries pieces of a photographed chemistry set along the wall, with liquids in strong colours.
  They are set dressing: they stand behind everything the child works with and take no part in the experiments.

Every number is in the `S` block at the end of `tools/lab-look.js`, including where each piece of the set stands.

The pictures start loading when `look.js` runs. `apply()` waits for them for at most 2.5 seconds, so the room never
shows one way and then changes; anything that is not in by then is left out and that part stays as the game draws it.

## Changing it

1. Edit `tools/lab-look.js`, then `node tools/apply-lab-look.mjs kitchen-lab chemistry-lab`.
2. To change the source assets, download them from Poly Haven (the 4K EXR for the HDRI, the 4K Blend ZIP for the
   textures and the model) into one folder and run `python tools/build-lab-look.py <folder>`. Record each asset in
   `apps/<id>/look/LICENSES.txt`.
3. Bump both manifests, run `node tools/phrases.mjs <id>` and `node tools/ladder-check.mjs <id> --drive`, and look at
   screenshots (`node tools/load-time.mjs <id> --shot out/a`).

`tools/apply-lab-textures.mjs` (textures drawn on first use) is a separate change to the same bundle.
