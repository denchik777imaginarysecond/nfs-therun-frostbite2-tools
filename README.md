# NFS The Run Explorer

**Mod manager and mod editor for Need for Speed: The Run** (PC, Frostbite 2), by **denchik777**.

- **Players:** install mods by dropping a `.nfsmod` file on a `.bat`. Several mods at once, conflicts reported, **the game files are never changed** (mods go into a separate `Update\Mods` folder; delete it to undo everything). Includes a one-click switch for the game's hidden **developer menu with Free Roam**.
- **Modders:** an editor in your web browser to browse all 91,715 assets, change values, texts, lists, references and objects, replace textures with PNGs, edit the game's texts, and save the result as a `.nfsmod`.
- **Researchers:** readers and writers for the game's formats (toc/sb, bundles, official patch deltas, ebx, textures, localization), each verified byte-for-byte on all the game's files.

Plain Node.js, no dependencies. The release zip includes Node.js, so players install nothing.

---

## Unlock Free Roam (for players)

The retail game still contains the developers' main menu entry **DEBUG** (documented earlier by [The Cutting Room Floor](https://tcrf.net/Need_for_Speed:_The_Run)). It opens a developer menu with **Start Free Roam**, Chapter Select, Stage Select and more. It is only hidden. This tool makes it visible. Nothing is downloaded from outside, and **your game files are not changed**: the tool writes one visibility flag into a separate folder, `Update\Mods`, which the game loads on top of its official patch. Deleting that folder undoes everything.

### You need

- Need for Speed: The Run for **PC**, with the official update installed (tested on that version)
- Windows
- Nothing else when you download the release zip that includes Node.js (a `node` folder next to the `.bat` files). Otherwise [Node.js](https://nodejs.org) 18 or newer (the "LTS" installer, default options)

### Install

1. **Download** `nfs-therun-tools-1.3.1-with-node.zip` from the [latest release](https://github.com/denchik777imaginarysecond/nfs-therun-frostbite2-tools/releases/latest) (Node.js included). If you already have Node.js, the source zip [v1.3.1](https://github.com/denchik777imaginarysecond/nfs-therun-frostbite2-tools/archive/refs/tags/v1.3.1.zip) works too.
2. **Unzip** it anywhere, for example to your Desktop. Not inside the game folder.
3. **Close the game.** Double-click **`enable_devmenu.bat`** and click **Yes** when Windows asks for administrator rights. The game sits in `Program Files`, so the tool needs them to change its files.
4. Wait for **Done** in the window, then press any key.
5. **Start the game.** The main menu now has a **DEBUG** item -> **Start Free Roam**.

The first run takes a few seconds longer and keeps about 300 MB of index data in the `output` folder next to the scripts.

### Undo

Close the game and double-click **`disable_devmenu.bat`**. It removes the `Update\Mods` folder (or rebuilds it with your other mods), and the game runs with its original files. Deleting `Update\Mods` by hand does the same.

If you used version 1.0.0 of this tool (it changed the game files directly), the new version undoes that automatically the first time it runs. After a repair of the game in EA app / Origin, just run `enable_devmenu.bat` (or `apply_mods.bat`) again if the menu is gone.

### Problems

| Problem | Fix |
|---|---|
| The window flashes and closes, nothing changes | Right-click the `.bat` -> **Run as administrator** |
| "Node.js was not found" | Download the release zip that includes Node.js, or install Node.js from [nodejs.org](https://nodejs.org), then run the `.bat` again |
| A window asks where the game is | The game was not found in the registry or the usual folders. Choose the game folder (the one with the `Data` folder) once; it is remembered in `game_path.txt` |
| Windows says "Windows protected your PC" | It does that for `.bat` files from the internet. Click "More info" → "Run anyway" |
| DEBUG does not appear | Make sure the game was closed and that `Done` was shown. Open `manage_mods.bat`: Developer Menu must be ON; press A to apply |
| Something in the developer menu crashes or does nothing | The menu was made for internal builds; not every entry works in the retail game. Free Roam does |
| Driving physics feels odd in places | Free Roam was a developer test mode; the game is also built for 30 FPS, and higher frame rates are known to affect its physics |

### Installing other mods

Mods come as **`.nfsmod`** files. They hold no game files, only a description of the changes, which are applied to your own game.

- **Install:** drag a `.nfsmod` file onto **`install_mod.bat`**. It is installed, enabled, and all enabled mods are applied together.
- **Undo everything:** **`restore_game.bat`** removes `Update\Mods`, so the game runs with its original files. Installed mods stay, and **`apply_mods.bat`** applies them again.
- **Manage:** double-click **`manage_mods.bat`**: a simple menu to switch mods on/off, remove them, change their order and apply. (In a terminal: `node fb2_mods.js list | enable <id> | disable <id> | remove <id> | check`.)

The developer menu itself is a mod too (`examples/DeveloperMenu`); `enable_devmenu.bat` / `disable_devmenu.bat` just switch it on or off together with your other mods.

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

### Editor (in your browser)

Double-click **`editor.bat`** (or `node fb2_editor.js`). It starts a small local server (127.0.0.1 only) and opens `http://localhost:8777`. It only reads the game files, so no administrator rights are needed.

- Browse all 91,715 ebx and 18,154 textures by folder, or search by name.
- EBX: every object and value as the game sees it (official patch applied), and which bundles contain the asset.
- Textures: preview with background and transparency switches. **Replace with PNG…** puts your picture in (any size; it is resized to the texture, mip-mapped and DXT-compressed like the game expects), and "Modded (as in game)" shows the compressed result next to the original. DXT1 and DXT5 textures.
- **Objects:** **Duplicate** adds a copy of an object (then point a reference or a list item to it), **Delete** removes one (with a warning when other files reference it).
- **Edit:** click a value: booleans, numbers, enums, texts; references open a picker (null, an object of the same file, or any other asset by search). Lists: **＋ Add** appends a copy of the last item, **✕** removes an item. References are links: click to open the target; each asset shows which files use it. Changes are highlighted, can be undone one by one, and are kept in a project (`output/editor_project.json`) until you save.
- **Texts:** search all texts the player sees (by words or id) and change them by clicking (Enter saves, Esc cancels, any length).
- **Project → Save:** writes `my_mods/<name>-<version>.nfsmod` (with your PNGs inside); "Save and install for me" also installs it, then run `apply_mods.bat`. Objects are found by a unique Name/Label/Id when they have one, otherwise by index.

Not yet: new objects of a type the file does not already have; textures in formats other than DXT1/DXT5.

### Making a mod (.nfsmod)

A mod is a folder (or a ZIP renamed to `.nfsmod`) with a `mod.json` and optional PNG files:

```json
{
  "format": 1,
  "name": "Developer Menu",
  "version": "1.0.0",
  "author": "you",
  "description": "What the mod does",
  "changes": [
    { "type": "ebx", "asset": "_c4/ui/flow/screen/menu_mainmenu",
      "where": { "Label": "ID_MENU_DEBUG" },
      "set": { "Visibility.DataCategory": null, "Visibility.DataKey": 0, "Visibility.InvertValue": false } },
    { "type": "texture", "asset": "_c4/vehicles/nfs/che_cam_ss_67/vinyls/che_cam_ss_67_rare_texture_win32", "png": "my_livery.png" },
    { "type": "text", "id": "ef524206", "value": "DEVELOPER MENU" },
    { "type": "file", "kind": "res", "name": "<asset name>", "path": "files/asset.res" }
  ]
}
```

| Change | What it does |
|---|---|
| `ebx` | Changes an ebx object. `where` picks the object whose fields have the given values, `"object": "<GUID>"` picks it by its GUID (what the editor writes), `"instance": n` by number; add `"all": true` to change every `where` match. `"duplicate": { "guid": "<32 hex>", "set": {…} }` adds a copy of the object (refer to it with `{ "object": "<that GUID>" }`); `"delete": true` removes it (references to it become null, list items pointing to it are removed; not the file's main object). Then runs `"remove"` (list items by their original number, e.g. `["Items.7"]`), then `"append"` (`{ "Items": <item or [items]> }`), then `"set"` (`{ "<path>": <value> }`). Paths: `Visibility.InvertValue`, `Items.3.Name`. Values: true/false, numbers, enum names, text of any length, `null`, `{ "ref": "<ebx name>" }` (another asset's main object; add `"object": "<instance GUID>"` for another object), `{ "$instance": n }` (an object of the same file). New list items that are objects only need the fields you set; the rest start empty. The whole ebx is rewritten (see `fb2_ebx_write.js`). |
| `texture` | Replaces a texture with a PNG (resized to the texture's size; DXT1/DXT5 textures). |
| `text` | Changes a text the player sees (menu items, car names, hints, subtitles), any length. `id` is the 8-digit text id (find it with `node fb2_loc.js --game "<game dir>" find <words>` or in the editor's Texts tab). Without `"lang"` it changes every installed language. Characters missing from the game's font may not show up. |
| `file` | Replaces a whole ebx/res/chunk with a file from the mod (advanced; avoid shipping original game data). |

Find assets and values with `node fb2_extract.js --game "<game dir>" find <word>` and `node fb2_ebx_edit.js --game "<game dir>" show <ebx>`.

```bash
node fb2_mods.js new "My Mod"                 # creates my-mod/mod.json
node fb2_mods.js install my-mod               # install the folder while developing
node fb2_mods.js check                        # resolve every change, show conflicts
node fb2_mods.js apply --dry-run              # show what would be patched
node fb2_mods.js pack my-mod                  # -> my-mod-1.0.0.nfsmod to share
```

Mods are applied in load order (`list`); when two mods set the same value, the later one wins and `check`/`apply` report the conflict. `apply` builds all enabled mods together into one update package, `<game>\Update\Mods`: a copy of the official patch (about 45 MB) with the changes added and a version number one above the patch, so the game loads it instead of `Update\Patch`. The original game files are never written. Bundles that the patch takes from the base game are added to the package as delta bundles that reference the base `.sb`, so only changed data is stored. Not supported yet: assets in superbundles that the official patch does not touch (audio, terrain, CommonAssets, Globals).

### Modding (low level)

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

### EBX layout (NFS The Run)

Verified on all 91,715 ebx; `fb2_ebx_write.js selftest` rebuilds every one of them (and the 224,084 ebx copies in the official patch) byte-for-byte.

```
0x00 magic 0x0FB2D1CE        0x04 string table position      0x08 size of strings + payload + arrays
0x0C import count             0x10 0                          0x14 instance group count
0x18 complex type count       0x1C field count                0x20 names length
0x24 strings length           0x28 array count                0x2C payload length
0x30 file GUID                0x40 primary instance GUID
0x50 imports: N x [file GUID 16][instance GUID 16]
names, fields (16 bytes), complex types (16), instance groups [0][count][type] (one per type)
(align 16) arrays [offset][count][type], (align 16) strings, payload, array data
```

- **Strings:** in the order values are visited (instances, fields, list items when met); equal texts are stored once; padded to 16.
- **Payload:** instances one after another as [GUID 16][data], the GUID aligned to min(type alignment, 4); padded to 16, always keeping 4 bytes (the count slot of array 0).
- **Arrays:** every empty list uses the shared array 0. A non-empty list is numbered after the lists inside its items ("children first"); stored in number order as [u32 count][items], items aligned to max(4, item alignment) with the count right before them.
- **References:** 0 = null, high bit set = import number, otherwise instance number + 1.

### Files

| File | What it does |
|---|---|
| `enable_devmenu.bat`, `disable_devmenu.bat` | One-click developer menu unlock / undo (ask for administrator rights) |
| `install_mod.bat`, `manage_mods.bat`, `apply_mods.bat`, `restore_game.bat` | Install a dropped `.nfsmod`, apply enabled mods, restore the original game (ask for administrator rights) |
| `editor.bat`, `fb2_editor.js`, `editor/index.html` | Asset browser and value editor in the web browser; saves `.nfsmod` mods |
| `fb2_game.js` | Finds the game folder: registry, usual folders, or a folder picker; remembered in `game_path.txt` |
| `fb2_mods.js` | Mod manager: `.nfsmod` format, install/enable/disable/remove, conflict check, apply, pack |
| `fb2_zip.js` | Minimal ZIP reader/writer for `.nfsmod` |
| `examples/DeveloperMenu` | The developer menu unlock as a mod |
| `fb2_devmenu.js` | The logic behind them: switches the DeveloperMenu mod on/off through the mod manager |
| `fb2_extract.js` | TOC decryption, DbObject parser, bundle headers, zlib block decompression, asset index and extraction |
| `fb2_ebx.js` | EBX header parser: type names, GUID, imports, string table |
| `fb2_ebx_write.js` | Writes a whole ebx from its values (any size: texts, list items, new references). Rebuilding without changes is byte-identical for all 91,715 ebx and the 224,084 ebx copies in the official patch (`selftest`) |
| `fb2_ebx_fields.js` | Full ebx field reader: every instance and value (structs, arrays, enums, references), with the byte offset of each value. Parses all 91,715 ebx of the game |
| `fb2_ebx_edit.js` | Shows and edits ebx values as the game sees them (official patch applied) and writes the edited ebx as a mod |
| `fb2_analyze.js` | Reference graph: orphans, dangling references, phantom names, dev/debug content |
| `fb2_chunks.js` | Finds every chunk reference by scanning all decompressed ebx/res data |
| `fb2_loc.js` | Localization tables: read, search, and rebuild with texts of any length (new characters are added to the table); `selftest` checks a byte-identical rebuild |
| `fb2_texture.js` | Texture header parser and DXT decoder, writes PNG |
| `fb2_tex_import.js` | PNG to DXT1/DXT5 texture import: resize, mip levels, writes a chunk mod |
| `fb2_repack.js` | Write support: lossless DbObject/TOC writer, zlib block packer, `.sb` append, bundle rebuild, delta bundles, self-test |
| `fb2_patch.js` | Mod loader: `apply --package <dir>` builds the `Update\Mods` package; the older in-place mode (`apply`/`restore` with backups) is kept for migration and research |

Notes on the format, as found in this game: EBX header fields are 32-bit (unlike Battlefield 3). On PC, ebx instances are `[GUID][data]` packed with at most 4-byte alignment. Chunk GUIDs in bundle tables have their first three fields byte-swapped. Video and audio chunks are stored uncompressed.

## Findings

- **`Level_1200_BlackCanyon`** is a cut level. The audio bundle registry lists 24 levels: the 23 shipped ones plus Black Canyon, which sits between `1100_MillionDollar` and `1300_IndependencePass`. Only its sound bundle remains (a construction digger sound). There is no level data and no text for it.
- A **developer main menu** (`frontenddevgraph`) with *Start Free Roam*, *Free Roam Online*, Chapter/Stage Select and test screens. Its DEBUG entry was documented earlier by [The Cutting Room Floor](https://tcrf.net/Need_for_Speed:_The_Run); this project switches it on without editing game files, and **Free Roam works**.
- A **debug menu** (max speed, infinite health, jump cheat, no collision, teleport), an **unlock-all menu** and **QA tools**.
- **Demo and E3 leftovers**: demo menus, Japanese demo screens, `e3_pause`, the "demo expired" screen.
- Working names of shipped tracks: `deathvalley`, `panamintsprings`, `zioncanyon`, `yosemitenorth`.

## Author

Made by **denchik777** (GitHub [denchik777imaginarysecond](https://github.com/denchik777imaginarysecond), Reddit u/Imaginary-Second9581): the research, the file format work, the mod system and the editor. The findings were first published on Reddit.

If you use this code or its format notes in your own project, please credit **denchik777** and link this repository (the MIT license asks you to keep the copyright notice).

## Disclaimer

Not affiliated with Electronic Arts or Black Box. Need for Speed and The Run are trademarks of their respective owners. This project contains no game assets. It adds a folder to your own game installation (`Update\Mods`) and does not change the original game files, but use it at your own risk.

## License

[MIT](LICENSE)
