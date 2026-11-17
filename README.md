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

## Modding (experimental)

`fb2_patch.js` applies mods from a `mods/` folder. Mod files hold the **unpacked** asset data:

```
mods/chunk/<32-hex guid>.chunk        replaces a chunk (toc chunk list or bundle)
mods/ebx/<asset path>.ebx             replaces an ebx in every bundle that contains it
mods/res/<asset path>.res             replaces a res in every bundle that contains it
```

Texture import: `node fb2_tex_import.js --game "<game dir>" my.png che_cam_ss_67/vinyls/` writes a chunk mod for every texture whose name contains the text. A chunk mod also updates the copies of that chunk inside base bundles.

```bash
node fb2_patch.js --game "<game dir>" apply --dry-run   # show the plan, write nothing
node fb2_patch.js --game "<game dir>" apply             # patch the game
node fb2_patch.js --game "<game dir>" status
node fb2_patch.js --game "<game dir>" restore           # undo everything
```

How it stays safe:

- **Append-only.** New data is written at the end of the `.sb`. Existing bytes are never changed.
- Every `.toc` is copied to `.toc.bak` before its first change. For each `.sb` the original size and the sha1 of its first and last MB are recorded, and `restore` checks them before truncating the file back.
- `apply` always restores first, so running it again starts from clean files.
- Bundles that the official patch stores as **delta bundles** (`delta=true` in `Update/Patch`) get a new delta appended to the patch `.sb`. The new delta holds the new header and the changed data inline, and refers to the unchanged data where it already is. The base game and `common.dat` are not touched.
- The game usually sits in `Program Files`, so patching needs a terminal started as administrator.

Verified:

- **In the game:** replacing a localization chunk works. The game loads the modified `.toc` (the header signature is not enforced) and reads the appended, recompressed data: every menu label showed the test marker. Localization is read from `Update/Patch`, not from `Data`.
- Offline: all 100 `.toc` files re-encode byte-for-byte; unchanged bundles rebuild byte-for-byte; `restore` returns byte-identical files (`node fb2_repack.js --game "<game dir>" selftest`).
- **In the game:** replacing a res inside bundles works. The texture headers of every livery of the Chevrolet Camaro SS (1967) were swapped in 17 rebuilt bundles in `ShippingVehicles.sb`. In a race the car lost its camo livery, and after `restore` the livery came back. (Garage previews are pre-rendered images and do not change.)
- **In the game:** PNG texture import works. A test pattern imported with `fb2_tex_import.js` into the Camaro SS (1967) liveries showed on the car in a race. In the garage the 3D car showed it for a moment and then switched back, probably because the garage also loads data from official patch delta bundles.
- **In the game:** patching official delta bundles works. The Chevrolet garage logo header was swapped for the Dodge one in 26 delta bundles (menu, game config, every level), and the garage showed the Dodge logo for Chevrolet.

## Recipe: unlock the developer menu (Free Roam)

The main menu has a hidden item `ID_MENU_DEBUG` (in `_c4/ui/flow/screen/menu_mainmenu`). Selecting it opens `FrontEndDevGraph`: Start Free Roam, Chapter Select, Stage Select and more. In the retail game the item is hidden by a visibility condition. This makes it always visible, like the other items:

```bash
node fb2_ebx_edit.js --game "<game dir>" set _c4/ui/flow/screen/menu_mainmenu 5.Visibility.DataCategory=null 5.Visibility.DataKey=0 5.Visibility.InvertValue=false
node fb2_patch.js --game "<game dir>" apply      # as administrator; undo with: restore
```

**Verified in the game:** the item appears in the main menu, the developer menu opens, and Free Roam lets you drive freely around the map. The developer menu was made for internal builds, so some entries may not work in retail.

## Official patch delta bundles

A patch bundle with `delta=true` is an assembly list, not a binary diff:

```
[u32 BE table length][u32 BE 0xDE17AAAA][u32 0][u32 0]
table: N x [u32 size][i32 source][u32 offset high][u32 offset low]
inline data
```

The bundle is all segments concatenated in order. Source `0` = the next bytes of the inline data, `1` = the base game `.sb` at the absolute offset, `-1` = `Update/Patch/Data/common.dat` at the absolute offset. All 372 delta bundles of the game rebuild with every entry matching its header sha1, and re-encoding them without changes gives identical bundles.

## Files

| File | What it does |
|---|---|
| `fb2_extract.js` | TOC decryption, DbObject parser, bundle headers, zlib block decompression, asset index and extraction |
| `fb2_ebx.js` | EBX (partition) parser: type names, GUID, imports, string table |
| `fb2_analyze.js` | Reference graph: orphans, dangling references, phantom names, dev/debug content |
| `fb2_chunks.js` | Finds every chunk reference by scanning all decompressed ebx/res data |
| `fb2_loc.js` | Decoder for `LocalizedStringResource` string tables |
| `fb2_texture.js` | Texture header parser and DXT decoder, writes PNG |
| `fb2_repack.js` | Write support: lossless DbObject/TOC writer, zlib block packer, `.sb` append, bundle rebuild, self-test |
| `fb2_patch.js` | Mod loader: `apply`, `restore`, `status`, with backups |
| `fb2_tex_import.js` | PNG to DXT1/DXT5 texture import: resize, mip levels, writes a chunk mod for `fb2_patch.js` |
| `fb2_ebx_fields.js` | Full ebx field reader: every instance and value (structs, arrays, enums, references), with the byte offset of each value. Parses all 91,715 ebx of the game |
| `fb2_ebx_edit.js` | Shows and edits ebx values as the game sees them (official patch applied) and writes the edited ebx as a mod |

Notes on the format, as found in this game: EBX header fields are 32-bit (unlike Battlefield 3). Chunk GUIDs in bundle tables have their first three fields byte-swapped. Video and audio chunks are stored uncompressed.

## Findings

- **`Level_1200_BlackCanyon`** is a cut level. The audio bundle registry lists 24 levels: the 23 shipped ones plus Black Canyon, which sits between `1100_MillionDollar` and `1300_IndependencePass`. Only its sound bundle remains (a construction digger sound). There is no level data and no text for it.
- A **developer main menu** (`frontenddevgraph`) with *Start Free Roam*, *Free Roam Online*, Chapter/Stage Select and test screens. **It can be unlocked in the retail game, and Free Roam works** (see the recipe above).
- A **debug menu** (max speed, infinite health, jump cheat, no collision, teleport), an **unlock-all menu** and **QA tools**. They are wired into the retail menus behind switches. Whether they work in retail has not been tested.
- **Demo and E3 leftovers**: demo menus, Japanese demo screens, `e3_pause`, the "demo expired" screen.
- Working names of shipped tracks: `deathvalley`, `panamintsprings`, `zioncanyon`, `yosemitenorth`.

## Author

Made by **denchik777imaginarysecond** (u/Imaginary-Second9581 on Reddit). The research and findings were first published on Reddit.

## Disclaimer

Not affiliated with Electronic Arts or Black Box. Need for Speed and The Run are trademarks of their respective owners. This project contains no game assets.

## License

[MIT](LICENSE)
