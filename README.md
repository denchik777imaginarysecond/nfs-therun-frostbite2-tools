# NFS The Run Explorer

Read-only tools for exploring the data files of **Need for Speed: The Run** (PC, Frostbite 2): TOC/SB archives, bundles, EBX assets, chunks, textures and localization tables. Written from scratch in plain Node.js, with no dependencies.

The game files are only read, never modified. **No game data is included in this repository.** You need your own copy of the game.

## Requirements

- Node.js 18 or newer
- Need for Speed: The Run (PC)

## Usage

Every script takes the same two options:

| Option | Meaning |
|---|---|
| `--game <path>` | Game folder (or its `Data` folder). Can also be set with the `NFS_THE_RUN_DIR` environment variable. |
| `--out <path>` | Output folder. Default: `./output` |

```bash
# 1. Build the asset index from all TOC/SB files (takes a few seconds)
node fb2_extract.js --game "C:/Games/Need For Speed The Run" index

# 2. Search asset names, then extract matching ebx/res assets
node fb2_extract.js --game "<game dir>" find blackcanyon debugmenu
node fb2_extract.js --game "<game dir>" extract debugmenu

# 3. Parse every EBX asset, build the reference graph, extract suspect assets, write output/REPORT.md
node fb2_analyze.js --game "<game dir>"

# 4. Check which chunks are referenced, and by whom
node fb2_chunks.js --game "<game dir>"

# 5. Decode the localization tables (needs step 3)
node fb2_loc.js --game "<game dir>" ru

# 6. Convert textures to PNG (DXT1/DXT5/BGRA)
node fb2_texture.js --game "<game dir>" garage/preview
```

## Files

| File | What it does |
|---|---|
| `fb2_extract.js` | TOC decryption, DbObject parser, bundle headers, zlib block decompression, asset index and extraction |
| `fb2_ebx.js` | EBX (partition) parser: type names, GUID, imports, string table |
| `fb2_analyze.js` | Reference graph: orphans, dangling references, phantom names, dev/debug content |
| `fb2_chunks.js` | Finds every chunk reference by scanning all decompressed ebx/res data |
| `fb2_loc.js` | Decoder for `LocalizedStringResource` string tables |
| `fb2_texture.js` | Texture header parser and DXT decoder, writes PNG |

Notes on the format, as found in this game: EBX header fields are 32-bit (unlike Battlefield 3). Chunk GUIDs in bundle tables have their first three fields byte-swapped. Video and audio chunks are stored uncompressed.

## Findings

- **`Level_1200_BlackCanyon`** is a cut level. The audio bundle registry lists 24 levels: the 23 shipped ones plus Black Canyon, which sits between `1100_MillionDollar` and `1300_IndependencePass`. Only its sound bundle remains (a construction digger sound). There is no level data and no text for it.
- A **developer main menu** (`frontenddevgraph`) with *Start Free Roam*, *Free Roam Online*, Chapter/Stage Select and test screens.
- A **debug menu** (max speed, infinite health, jump cheat, no collision, teleport), an **unlock-all menu** and **QA tools**. They are wired into the retail menus behind switches. Whether they work in retail has not been tested.
- **Demo and E3 leftovers**: demo menus, Japanese demo screens, `e3_pause`, the "demo expired" screen.
- Working names of shipped tracks: `deathvalley`, `panamintsprings`, `zioncanyon`, `yosemitenorth`.

## Author

Made by **denchik777imaginarysecond** (u/Imaginary-Second9581 on Reddit). The research and findings were first published on Reddit.

## Disclaimer

Not affiliated with Electronic Arts or Black Box. Need for Speed and The Run are trademarks of their respective owners. This project contains no game assets.

## License

[MIT](LICENSE)
