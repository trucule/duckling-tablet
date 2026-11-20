#!/usr/bin/env bash
# Puts the Spanish speech model for Read It Say It Make It on the droplet (models/README.md). Run as root on the
# droplet after a deploy:
#
#   ssh root@<droplet> "bash /opt/duckling/src/deploy/install-vosk-es.sh"
#
# Downloads vosk-model-small-es-0.42 from Alpha Cephei (Apache License 2.0), copies the files the app fetches into
# /opt/duckling/src/models/vosk-small-es/, leaves out graph/Gr.fst (the app recognizes against the passage's own
# words, so the language model is not read), makes the files world readable for the duckling service user, and
# checks one of them through the running API. A run on a droplet that already has the model replaces it. The files
# are ignored by git, so a deploy's git reset leaves them in place.
set -euo pipefail
SRC=/opt/duckling/src
DEST="$SRC/models/vosk-small-es"
URL=https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

command -v unzip >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q unzip >/dev/null 2>&1
echo "Downloading $URL"
curl -fsSL --retry 3 -o "$TMP/model.zip" "$URL"
unzip -q "$TMP/model.zip" -d "$TMP"
MODEL=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d -name 'vosk-model-small-es*' | head -1)
[ -n "$MODEL" ] || { echo "The archive did not contain a vosk-model-small-es folder" >&2; exit 1; }

# The list the app fetches: apps/read-it-say-it/vosk/model-list.js is the source of truth.
FILES=(am/final.mdl conf/mfcc.conf conf/model.conf graph/HCLr.fst graph/disambig_tid.int graph/phones/word_boundary.int graph/words.txt ivector/final.dubm ivector/final.ie ivector/final.mat ivector/global_cmvn.stats ivector/online_cmvn.conf ivector/splice.conf)
# Vosk's small models carry no graph/words.txt; the app needs it, so it is made from Gr.fst's symbol table.
[ -f "$MODEL/graph/words.txt" ] || node "$SRC/tools/fst-words.mjs" "$MODEL/graph/Gr.fst" "$MODEL/graph/words.txt"
for f in "${FILES[@]}"; do
  [ -f "$MODEL/$f" ] || { echo "Missing in the archive: $f" >&2; exit 1; }
done
mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  mkdir -p "$DEST/$(dirname "$f")"
  install -m 0644 "$MODEL/$f" "$DEST/$f"
done
chmod -R a+rX "$DEST"
echo "Installed $(du -sh "$DEST" | cut -f1) into $DEST"

# The API serves the files from this folder with no restart.
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/models/vosk-small-es/conf/model.conf || true)
if [ "$code" = "200" ]; then echo "The API serves the model (200 on conf/model.conf)."; else echo "The API answered $code for conf/model.conf; check that duckling-api is running a build with backend/src/routes/models.ts." >&2; exit 1; fi
