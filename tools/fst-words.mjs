#!/usr/bin/env node
// Writes a Kaldi words.txt from the input symbol table of an OpenFst binary file.
//
//   node tools/fst-words.mjs graph/Gr.fst graph/words.txt
//
// Vosk's small models ship graph/Gr.fst and graph/HCLr.fst but no graph/words.txt. Read It Say It Make It reads
// words.txt to know which words a model can hear (speech.js, S.vocab), so deploy/install-vosk-es.sh makes it from
// Gr.fst, whose input symbols are the model's words. Format (OpenFst): a header (int32 magic, two length-prefixed
// strings, int32 version, int32 flags, uint64 properties, three int64s), then, when flags has bit 1, the input
// SymbolTable (int32 magic, length-prefixed name, int64 available key, int64 size, then size entries of a
// length-prefixed symbol and an int64 key). Little endian throughout.
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node tools/fst-words.mjs <Gr.fst> <words.txt>'); process.exit(2); }
const b = readFileSync(src);
let off = 0;
const i32 = () => { const v = b.readInt32LE(off); off += 4; return v; };
const i64 = () => { const v = b.readBigInt64LE(off); off += 8; return v; };
const str = () => { const n = i32(); const s = b.subarray(off, off + n).toString('utf8'); off += n; return s; };
if (i32() !== 2125659606) { console.error(`${src}: not an OpenFst file`); process.exit(1); }
str(); str(); i32();            // fst type, arc type, version
const flags = i32();
i64(); i64(); i64(); i64();      // properties, start, states, arcs
if (!(flags & 1)) { console.error(`${src}: no input symbol table`); process.exit(1); }
if (i32() !== 2125658996) { console.error(`${src}: symbol table magic not found`); process.exit(1); }
str(); i64();                    // table name, next available key
const size = Number(i64());
const lines = [];
for (let i = 0; i < size; i++) { const s = str(); const k = i64(); lines.push(`${s} ${k}`); }
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${out}: ${size} words from ${src}`);
