# NFS The Run Explorer

Tools for **Need for Speed: The Run** (PC, Frostbite 2). They unlock the game's hidden **developer menu with Free Roam**, and give researchers and modders a reader and patcher for the game's data files. Plain Node.js, no dependencies.

**[Инструкция на русском →](README.ru.md)**

---

## Unlock Free Roam (for players)

The retail game still contains the developers' main menu entry **DEBUG**. It opens a developer menu with **Start Free Roam**, Chapter Select, Stage Select and more. It is only hidden. This tool makes it visible. Nothing is downloaded or added from outside: it changes one visibility flag in your own game files, keeps backups, and can undo everything.

### You need

- Need for Speed: The Run for **PC**, with the official update installed (tested on that version)
- Windows
- [Node.js](https://nodejs.org) 18 or newer (the "LTS" installer, default options)

### Install

1. **Download** [nfs-therun-frostbite2-tools-1.0.0.zip](https://github.com/denchik777imaginarysecond/nfs-therun-frostbite2-tools/archive/refs/tags/v1.0.0.zip) (or the green **Code → Download ZIP** button for the latest version).
2. **Unzip** it anywhere, for example to your Desktop. Not inside the game folder.
3. **Close the game.** Double-click **`enable_devmenu.bat`** and click **Yes** when Windows asks for administrator rights. The game sits in `Program Files`, so the tool needs them to change its files.
4. Wait for **Done** in the window, then press any key.
5. **Start the game.** The main menu now has a **DEBUG** item -> **Start Free Roam**.

The first run takes a few seconds longer and keeps about 300 MB of index data in the `output` folder next to the scripts.

### Undo

Close the game and double-click **`disable_devmenu.bat`**. It restores every changed file byte for byte.

**Undo before you update or repair the game** (EA app / Origin). A repair restores the original files anyway, so afterwards you can simply run `enable_devmenu.bat` again.

### Problems

| Problem | Fix |
|---|---|
| The window flashes and closes, nothing changes | Right-click the `.bat` -> **Run as administrator** |
| "Node.js is not installed" | Install Node.js from [nodejs.org](https://nodejs.org), then run the `.bat` again |
| "Could not find Need for Speed: The Run" | The game is in a custom folder. Open a terminal in the tool's folder and run `enable_devmenu.bat --game "D:\Games\Need For Speed The Run"` (your path) |
| DEBUG does not appear | Make sure the game was closed while patching, and that `Done` was shown. Run `node fb2_devmenu.js status` to see what is patched |
| Something in the developer menu crashes or does nothing | The menu was made for internal builds; not every entry works in the retail game. Free Roam does |
| Driving physics feels odd in places | Free Roam was a developer test mode; the game is also built for 30 FPS, and higher frame rates are known to affect its physics |

---

## For researchers and modders

Every script takes the same two options:

| Option | Meaning |
|---|---|
| `--game <path>` | Game folder (or its `Data` folder). Can also be set with the `NFS_THE_RUN_DIR` environment variable. |
| `--out <path>` | Output folder. Default: `./output` |

### Reading the data

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

# 7. Show every value inside an ebx, as the game sees it (official patch applied)
node fb2_ebx_edit.js --game "<game dir>" show _c4/ui/flow/screen/menu_mainmenu
```

### Modding

`fb2_patch.js` applies mods from a `mods/` folder. Mod files hold the **unpacked** asset data:

```
mods/chunk/<32-hex guid>.chunk        replaces a chunk (toc chunk list or bundle)
mods/ebx/<asset path>.ebx             replaces an ebx in every bundle that contains it
mods/res/<asset path>.res             replaces a res in every bundle that contains it
```

Ways to make mods:

- **Edit values inside an ebx:** `node fb2_ebx_edit.js --game "<game dir>" set <ebx> <instance>.<field>=<value>` writes `mods/ebx/...` (bool, numbers, enums, null references; edited in place).
- **Import a texture:** `node fb2_tex_import.js --game "<game dir>" my.png che_cam_ss_67/vinyls/` writes a chunk mod for every texture whose name contains the text. A chunk mod also updates the copies of that chunk inside base bundles.

```bash
node fb2_patch.js --game "<game dir>" apply --dry-run   # show the plan, write nothing
node fb2_patch.js --game "<game dir>" apply             # patch the game (as administrator)
node fb2_patch.js --game "<game dir>" status
node fb2_patch.js --game "<game dir>" restore           # undo everything
```

How it stays safe:

- **Append-only.** New data is written at the end of the `.sb`. Existing bytes are never changed.
- Every `.toc` is copied to `.toc.bak` before its first change. For each `.sb` the original size and the sha1 of its first and last MB are recorded, and `restore` checks them before truncating the file back.
- `apply` always restores first, so running it again starts from clean files.
- Bundles that the official patch stores as **delta bundles** (`delta=true` in `Update/Patch`) get a new delta appended to the patch `.sb`. The new delta holds the new header and the changed data inline, and refers to the unchanged data where it already is. The base game and `common.dat` are not touched.

Verified in the game:

- Replacing a localization chunk: every menu label showed the test marker. The `.toc` header signature is not enforced. Localization is read from `Update/Patch`.
- Replacing a res inside bundles: swapping the livery texture headers of the Chevrolet Camaro SS (1967) removed its camo livery in a race; `restore` brought it back.
- PNG texture import: a test pattern showed on the Camaro in a race.
- Patching official delta bundles: the Chevrolet garage logo was replaced with the Dodge one in 26 delta bundles.
- Editing an ebx value: the hidden **DEBUG** main menu item appears, and **Free Roam works**.
- Offline: all 100 `.toc` files re-encode byte-for-byte, unchanged bundles rebuild byte-for-byte, and `restore` returns byte-identical files (`node fb2_repack.js --game "<game dir>" selftest`).

### The developer menu, step by step

The main menu has a hidden item `ID_MENU_DEBUG` (in `_c4/ui/flow/screen/menu_mainmenu`). Its visibility is bound to a game flag and inverted, so the retail game hides it. Selecting it leads, through the main menu graph `mainmenuroot`, to `FrontEndDevGraph`. `fb2_devmenu.js` gives the item the same always-visible setting as the other items. By hand:

```bash
node fb2_ebx_edit.js --game "<game dir>" set _c4/ui/flow/screen/menu_mainmenu 5.Visibility.DataCategory=null 5.Visibility.DataKey=0 5.Visibility.InvertValue=false
node fb2_patch.js --game "<game dir>" apply
```

### Official patch delta bundles

A patch bundle with `delta=true` is an assembly list, not a binary diff:

```
[u32 BE table length][u32 BE 0xDE17AAAA][u32 0][u32 0]
table: N x [u32 size][i32 source][u32 offset high][u32 offset low]
inline data
```

The bundle is all segments concatenated in order. Source `0` = the next bytes of the inline data, `1` = the base game `.sb` at the absolute offset, `-1` = `Update/Patch/Data/common.dat` at the absolute offset. All 372 delta bundles of the game rebuild with every entry matching its header sha1, and re-encoding them without changes gives identical bundles.

### Files

| File | What it does |
|---|---|
| `enable_devmenu.bat`, `disable_devmenu.bat` | One-click developer menu unlock / undo (ask for administrator rights) |
| `fb2_devmenu.js` | The logic behind them: `enable`, `disable`, `status` |
| `fb2_extract.js` | TOC decryption, DbObject parser, bundle headers, zlib block decompression, asset index and extraction |
| `fb2_ebx.js` | EBX header parser: type names, GUID, imports, string table |
| `fb2_ebx_fields.js` | Full ebx field reader: every instance and value (structs, arrays, enums, references), with the byte offset of each value. Parses all 91,715 ebx of the game |
| `fb2_ebx_edit.js` | Shows and edits ebx values as the game sees them (official patch applied) and writes the edited ebx as a mod |
| `fb2_analyze.js` | Reference graph: orphans, dangling references, phantom names, dev/debug content |
| `fb2_chunks.js` | Finds every chunk reference by scanning all decompressed ebx/res data |
| `fb2_loc.js` | Decoder for `LocalizedStringResource` string tables |
| `fb2_texture.js` | Texture header parser and DXT decoder, writes PNG |
| `fb2_tex_import.js` | PNG to DXT1/DXT5 texture import: resize, mip levels, writes a chunk mod |
| `fb2_repack.js` | Write support: lossless DbObject/TOC writer, zlib block packer, `.sb` append, bundle rebuild, delta bundles, self-test |
| `fb2_patch.js` | Mod loader: `apply`, `restore`, `status`, with backups |

Notes on the format, as found in this game: EBX header fields are 32-bit (unlike Battlefield 3). On PC, ebx instances are `[GUID][data]` packed with at most 4-byte alignment. Chunk GUIDs in bundle tables have their first three fields byte-swapped. Video and audio chunks are stored uncompressed.

## Findings

- **`Level_1200_BlackCanyon`** is a cut level. The audio bundle registry lists 24 levels: the 23 shipped ones plus Black Canyon, which sits between `1100_MillionDollar` and `1300_IndependencePass`. Only its sound bundle remains (a construction digger sound). There is no level data and no text for it.
- A **developer main menu** (`frontenddevgraph`) with *Start Free Roam*, *Free Roam Online*, Chapter/Stage Select and test screens. **It can be unlocked in the retail game, and Free Roam works.**
- A **debug menu** (max speed, infinite health, jump cheat, no collision, teleport), an **unlock-all menu** and **QA tools**.
- **Demo and E3 leftovers**: demo menus, Japanese demo screens, `e3_pause`, the "demo expired" screen.
- Working names of shipped tracks: `deathvalley`, `panamintsprings`, `zioncanyon`, `yosemitenorth`.

## Author

Made by **denchik777imaginarysecond** (u/Imaginary-Second9581 on Reddit). The research and findings were first published on Reddit.

## Disclaimer

Not affiliated with Electronic Arts or Black Box. Need for Speed and The Run are trademarks of their respective owners. This project contains no game assets. It changes files of your own game installation; it keeps backups and can undo its changes, but use it at your own risk.

## License

[MIT](LICENSE)
