# Speech models the API serves

`GET /models/<model>/<path>` (`backend/src/routes/models.ts`) sends the file at `models/<model>/<path>` to any
origin with long caching, the way `/fonts` serves `fonts/`. A tablet downloads a model the first time an app needs it
and keeps it in the app's IndexedDB, so the download happens once per tablet.

The model files are not in git: this folder holds the README and an empty `vosk-small-es/`, and
`vosk-small-es/.gitignore` keeps the files out of a commit. Chris places them on the droplet. `deploy-remote.sh`
resets the checkout to `origin/main` but leaves untracked files alone, so they survive a deploy.

## vosk-small-es: Spanish speech recognition for Read It Say It Make It

Source: `vosk-model-small-es-0.42` from https://alphacephei.com/vosk/models (Alpha Cephei, Apache License 2.0). The
English model is packed inside the app (`apps/read-it-say-it/vosk/`); the Spanish one is served from here because
the app is already large and only Spanish tablets need it.

The one-step way, as root on the droplet: `bash /opt/duckling/src/deploy/install-vosk-es.sh` downloads the
archive, copies the files below into place, sets permissions, and checks the API serves them. By hand instead:
unzip the archive and copy these files, keeping the folders, into `/opt/duckling/src/models/vosk-small-es/`:

```
am/final.mdl
conf/mfcc.conf
conf/model.conf
graph/HCLr.fst
graph/disambig_tid.int
graph/phones/word_boundary.int
graph/words.txt
ivector/final.dubm
ivector/final.ie
ivector/final.mat
ivector/global_cmvn.stats
ivector/online_cmvn.conf
ivector/splice.conf
```

This is the list in `apps/read-it-say-it/vosk/model-list.js`, the one the app fetches for both languages. The
archive has no `graph/words.txt`; the install script writes it from `graph/Gr.fst`'s symbol table with
`node tools/fst-words.mjs` (by hand: `node tools/fst-words.mjs graph/Gr.fst graph/words.txt` inside the unzipped
folder before copying).
`graph/Gr.fst` is left out on purpose: the app always recognizes against a grammar made of the passage's own words,
so the language model is not read. `README` and the rest of the archive are not needed.

From the PC, after unzipping to `D:\Downloads\vosk-model-small-es-0.42`:

```
scp -r D:\Downloads\vosk-model-small-es-0.42\am D:\Downloads\vosk-model-small-es-0.42\conf D:\Downloads\vosk-model-small-es-0.42\graph D:\Downloads\vosk-model-small-es-0.42\ivector root@<droplet>:/opt/duckling/src/models/vosk-small-es/
ssh root@<droplet> "rm -f /opt/duckling/src/models/vosk-small-es/graph/Gr.fst && chmod -R a+rX /opt/duckling/src/models/vosk-small-es"
```

The service runs as `duckling`, so the files must be world readable (the `chmod` above). Check from anywhere:

```
curl -sI https://api.ducklingtablet.com/models/vosk-small-es/conf/model.conf
```

A 200 with `cache-control: public, max-age=2592000` means the model is live. Until then a Spanish tablet says the
Spanish listener is not ready and lets the child read without the check; it tries again the next time the app opens.

The app checks what it downloads before keeping it: `am/final.mdl` must be a Kaldi binary file, `graph/HCLr.fst`
an OpenFst file and `graph/words.txt` a word list. Any other content (an error page, a JSON body) is dropped and the
model counts as not available.
