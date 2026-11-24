# Photo backdrops

The 3D places in the apps (Story Maker's sets, My Avatar's places, Read It Say It Make It's skies) can show a
360-degree photo in place of their drawn sky and ground. Each app ships with its drawn version. The photo downloads
from the API the first time a child goes to that place and is kept on the tablet (`tools/backdrops.js`).

## Files

- `backdrops/<id>.jpg`: the 360-degree picture, 4096 by 2048.
- `backdrops/<id>-light.png`: its lighting, for the cast's reflections and fill light.
- `backdrops/backdrops.json`: one entry per photo with its source, sun direction, colour and strength, and the
  average sky and ground colours. `room` marks an indoor photo (how far its walls are, in camera heights).
- `backend/src/routes/backdrops.ts` serves them. A tablet asks for `backdrops.json` each time an app opens, so a
  new place reaches it without an app update. A file never changes under its name; a changed picture gets a new id.

## Adding a place

1. Get the picture.
   - Real places: a Poly Haven HDRI (polyhaven.com, CC0), the 4K `.hdr` file. Add its id to `KEEP` in
     `tools/build-backdrops.py`. A night photo also goes in `DARK`; an indoor picture of either kind goes in `ROOM`.
   - Made-up places: a generated 360-degree picture saved as `<id>.jpg`. Add it to `MADE` with where its sun is.
2. Run `python3 tools/build-backdrops.py <folder>` with only the new files in the folder. The other entries stay.
3. Point the app at it: `PHOTO` in `apps/story-maker/stage.js`, `PHOTO_PLACE` in `apps/my-avatar/avatar.js`,
   `PHOTO_SKY` in `apps/read-it-say-it/index.html`. `face` picks the part of the picture behind the cast; `sunAt`
   turns the picture by its sun instead.
4. If `tools/backdrops.js` changed, run `node tools/apply-backdrops.mjs story-maker my-avatar read-it-say-it`.
5. Look at a screenshot of every place that changed, then bump each app's manifest version.

Things to check in a screenshot: no letters or signs in view, no people, the cast stands on open ground, and the
picture's horizon meets the drawn ground where the two touch. My Avatar's camera sees only about 15 degrees above
the horizon, so the prompt asks for the main subject to sit low.

## Prompt for the made-up places

The made-up places were generated with Google Gemini from this prompt, one picture per reply, with "next" between
them. Replace the numbered list to make new ones; keep the rules paragraph.

```
I need separate images, one per reply message, never combined into a grid or collage. Make them in the order listed.
After each image, write only its file name, and wait for me to say "next" before making the following one.

Every image follows these rules: a single 360 degree equirectangular panorama, 2:1 aspect ratio, as large as you can
make it. The left and right edges must join seamlessly. The horizon is a straight line exactly at the vertical middle
of the image. The camera is at a child's eye level, about 1.2 meters above the ground. The ground in front of the
camera is flat and open for about 3 meters in every direction, so a person can stand there. Photorealistic, natural
lens, no fisheye bulge, soft realistic lighting, high detail. No people, no animals near the center, no text, no
letters, no logos, no signs, no watermark, no cartoon characters. Friendly and safe for young children.

1. under-the-sea: Standing on a flat sandy seabed in clear shallow tropical water about 6 meters deep. Bright coral
   reefs in many colors surround a wide sandy clearing. Small schools of fish swim in the distance. Sunlight comes
   down from above in visible light rays, with rippled light patterns on the sand. The water fades to soft blue in
   the distance. The water surface is visible overhead with the sun shining through it.
2. rainbow-hill: Standing on top of a gentle grassy hill covered in short green grass and small wildflowers in red,
   orange, yellow and purple. Rolling green hills continue to the horizon. A bright, wide, low rainbow stands on the
   hills in front of the camera, both of its ends touching the hills and its top only a little above the horizon, as
   if seen from far away. Fluffy white clouds in a blue sky after a light rain. The sun is behind the camera, low in
   the sky.
3. candy-land: Standing on a flat path of pastel pink and white tiles in a landscape made of candy. Giant lollipops
   and swirled candy canes grow like trees. Hills are covered in colorful gumdrops. A river of chocolate winds in the
   distance. Mountains topped with white frosting on the horizon. Soft pastel blue sky with cotton candy clouds.
   Everything looks like real candy with real textures and shine. Sun high and to the left.
4. cupcake-town: Standing in the open cobblestone square of a small storybook town where the cottages are shaped
   like giant cupcakes, with frosted roofs in pink, mint and vanilla, sprinkles on top, and wafer doors and windows.
   A fountain shaped like a tiered cake stands at the edge of the square. Pastel bunting hangs between the houses.
   Bright afternoon sun, blue sky with a few white clouds. The buildings look like real baked goods at house size.
5. cloud-kingdom: Standing on a wide, flat, firm platform of thick white cloud high above the earth. More cloud
   banks stretch to the horizon in every direction, with a few pale gold castle towers on distant clouds. A clear
   sky, deep blue above and soft pink and gold near the horizon. A bright sun low on one side lights the cloud edges
   gold.
6. ice-palace: Standing on flat, packed snow in the courtyard of a grand palace made of clear blue ice. Tall ice
   towers and arches surround the courtyard at a distance of 15 meters or more. Ice columns glow pale blue where
   sunlight passes through. Snow-covered mountains beyond the walls. Clear cold blue sky, sun low on one side,
   sparkling frost on every surface.
7. volcano-island: Standing on a flat stretch of dark volcanic sand on a tropical island. A wide, low volcano sits
   close by on one side, its whole cone visible and squat, its top only a little above the horizon, with a gentle
   plume of white steam drifting sideways, and no fire or danger. Low green jungle and a few short palm trees at its
   base, none of them blocking the view of the cone. Turquoise ocean and gentle waves on the other side. Bright midday
   sun, blue sky with some clouds.
8. big-stage: Standing in the middle of a large empty theater stage made of polished wooden boards. Deep red velvet
   curtains are pulled back at both sides. Warm spotlights shine down from above. Rows of red theater seats rise
   into a dim auditorium with balconies and soft golden wall lights. Warm, inviting, magical atmosphere.
9. outer-space: Standing on the flat, rocky gray surface of a small asteroid in outer space. Black sky full of
   bright stars and a colorful nebula in purple and blue. The planet Earth hangs large in the sky on one side, blue
   and white. A bright white sun on the other side lights the rocks with sharp shadows. Other small asteroids float
   in the distance.
10. moon: Standing on the flat, powdery gray surface of the Moon. Small craters and scattered rocks around, gentle
    gray hills on the horizon. Black sky full of stars. The Earth hangs low above the horizon on one side, blue and
    white. The sun is low on the other side, casting long sharp shadows across the dust.
11. snowy-meadow: Standing in the middle of a wide, flat meadow covered in fresh, smooth snow. Snow-covered pine
    trees form a ring at the edges of the meadow about 30 meters away. Snowy mountains on the horizon. Soft overcast
    winter sky with light snow falling. Calm, bright and peaceful.
12. snowy-mountain: Standing on a flat, snowy ledge high on a mountain. Tall snow-capped peaks rise all around, with
    rocky ridges showing through the snow. Valleys with pine forests far below on one side. Clear blue sky, bright
    sun high and to the left, crisp shadows on the snow.

13. kids-bedroom: Standing in the middle of a bright, tidy child's bedroom with a light wooden floor and a soft round
    rug in the center. A single bed with a colorful quilt and pillows against one wall, a low bookshelf with picture
    books and stuffed animals, a small desk with crayons, a toy chest, and a big window with daylight and light
    curtains. Pastel walls with a few framed drawings of animals and stars. No screens, no mirrors, no posters with
    words. Warm, cozy, cheerful daylight.
14. night-sky: Standing in the middle of a wide, flat, grassy meadow at night. The Milky Way and a very clear, bright
    sky full of stars reach all the way down to the horizon, with a big full moon low over the hills on one side
    lighting the meadow in soft silver light. Dark silhouettes of low rolling hills and a few distant trees on the
    horizon. No town lights, no buildings. Calm and magical, bright enough to see the grass.

Start with image 1 now.
```
