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

# 6. Convert textures to PNG (every format the game uses, see "Textures" below)
node fb2_texture.js --game "<game dir>" garage/preview

# 7. Export 3D models to .glb (Blender: File > Import > glTF)
node fb2_mesh.js --game "<game dir>" car che_cam_ss_67        # a whole car, wheels in place
node fb2_mesh.js --game "<game dir>" model che_cam_ss_67_kit00_stream_meshbody  # one model with every LOD, for editing

# 8. Show every value inside an ebx, as the game sees it (official patch applied)
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
    { "type": "mesh", "asset": "_c4/vehicles/nfs/che_cam_ss_67/kits/che_cam_ss_67_kit00_stream_meshbody", "glb": "body.glb" },
    { "type": "file", "kind": "res", "name": "<asset name>", "path": "files/asset.res" }
  ]
}
```

| Change | What it does |
|---|---|
| `ebx` | Changes an ebx object. `where` picks the object whose fields have the given values, `"object": "<GUID>"` picks it by its GUID (what the editor writes), `"instance": n` by number; add `"all": true` to change every `where` match. `"duplicate": { "guid": "<32 hex>", "set": {…} }` adds a copy of the object (refer to it with `{ "object": "<that GUID>" }`); `"delete": true` removes it (references to it become null, list items pointing to it are removed; not the file's main object). Then runs `"remove"` (list items by their original number, e.g. `["Items.7"]`), then `"append"` (`{ "Items": <item or [items]> }`), then `"set"` (`{ "<path>": <value> }`). Paths: `Visibility.InvertValue`, `Items.3.Name`. Values: true/false, numbers, enum names, text of any length, `null`, `{ "ref": "<ebx name>" }` (another asset's main object; add `"object": "<instance GUID>"` for another object), `{ "$instance": n }` (an object of the same file). New list items that are objects only need the fields you set; the rest start empty. The whole ebx is rewritten (see `fb2_ebx_write.js`). |
| `texture` | Replaces a texture with a PNG. The texture keeps its format (DXT1, DXT3, DXT5, BC4, BC5, DXT5 normal maps, L8, BGRA8) and, by default, its size. `"size": "png"` uses the picture's own size, `"size": [w, h]` any other (powers of two, 4 to 4096); the header and mip levels are rebuilt. |
| `mesh` | Replaces a 3D model with a `.glb` (export it with `fb2_mesh.js model`, edit it in Blender, export as glTF binary). Objects `lod0`, `lod1`, … replace those levels of detail; levels without an object get `lod0`'s (`"keepOtherLods": true` keeps the originals). Parts are matched by material name. New vertices take the game-specific data (bone, damage, colour) of the nearest original vertex, so the car still deforms in crashes; a triangle never mixes two bones (no stretched slivers when parts move). `"clearOthers": true` hides the parts the `.glb` does not have (except `"keepParts": [names]`), `"hide": true` (no `.glb`) hides the whole model, `"evenShade": true` gives new geometry an even light baked shade instead of the old shape's. |
| `text` | Changes a text the player sees (menu items, car names, hints, subtitles), any length. `id` is the 8-digit text id (find it with `node fb2_loc.js --game "<game dir>" find <words>` or in the editor's Texts tab). Without `"lang"` it changes every installed language. Characters missing from the game's font may not show up. |
| `add` | `{ "type": "add", "next": "<ebx name>", "add": ["<asset name>", …] }` copies those assets (the ebx, the res of the same name and the chunks that res uses) from a bundle that has them into every bundle that holds `next`. The game loads only the bundles it needs, so an ebx can only refer to assets in a bundle that is loaded with it. Example: a plain colour (a livery without a picture) gets a vinyl picture (see "Car liveries"). Copies get the mod's version of the asset when another change replaces it. |
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

Building models and textures takes up to a second each, so `apply` keeps the results in `output/cache`. The key covers everything a result depends on: the change, the bytes of the mod's `.glb`/`.png`, the game's asset index and the code that builds it. Running `apply` again with nothing changed takes a few seconds (the package is left as it is). Switching a mod on or off reuses the cached models. Entries not used for 30 days are removed.

### Modding (low level)

`fb2_patch.js` applies mods from a `mods/` folder. Mod files hold the **unpacked** asset data:

```
mods/chunk/<32-hex guid>.chunk        replaces a chunk (toc chunk list or bundle)
mods/ebx/<asset path>.ebx             replaces an ebx in every bundle that contains it
mods/res/<asset path>.res             replaces a res in every bundle that contains it
mods/adds/<any>.json                  { "next": "<ebx>", "add": ["<asset>", ...] }: copies assets into the bundles of "next"
mods/chunk/<guid>.chunk.json          { "logicalOffset": n }: hint for bundles that hold only the tail of a texture
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

### Bundle header

All numbers are big-endian; offsets marked * are counted from byte 4.

```
0x00 header size (from byte 4)   0x04 magic 0x970D1C13     0x08 entry count
0x0C ebx count    0x10 res count    0x14 chunk count      0x18 names at*    0x1C chunkMeta at*    0x20 chunkMeta size
0x24 sha1 of every entry's STORED bytes (20 each; ebx, then res, then chunks)
     ebx + res: [name at, stored size, unpacked size] (12 each)
     res types (4 each), res meta (16 each)
     chunks: [GUID 16 (first three fields byte-swapped), A, B, C] (28 each)
     chunkMeta: a DbObject list, one item per chunk: { h32, meta { firstMip } }
     names (zero-terminated; an ebx and a res with the same name share one)
     padding to 16, then the data of every entry, each 16-byte aligned
```

- A chunk entry with `A = 0` holds the whole chunk (stored size `B`). With `A > 0` it holds only the tail (a texture without the levels streamed later): `A` = where the tail starts in the packed full chunk, `B` = packed full size, `C` = logical offset of the tail. The packed chunk must have a block border at `C`.
- `fb2_repack.js` reads and writes the whole header (`parseBundle` / `writeBundle`). Rebuilding all 3,799 bundles of the vehicle and UI superbundles without changes gives identical bytes. `addToBundle` adds entries of other bundles (stored bytes, sha1 and metadata as they are).
- Small livery bundles (`_c4/blueprint/liverybundles/bb_<car>_<livery>`) hold one livery, and its picture when it has one. The game's own liveries always keep their picture in their own bundle; the `add` change does the same for liveries that get a picture. This works in the game.

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

### Textures (res type `5c4954a6`)

The texture res is a 128-byte header; the pixels are a chunk (all mip levels, largest first). The TextureAsset ebx holds only the name.

```
0x08 format            0x0C flags               0x10 width (u16)     0x12 height (u16)
0x14 depth / slices    0x1A mip count           0x1B first mip loaded later (streaming)
0x1C chunk GUID        0x2C mip sizes (15 x u32) 0x68 total size      0x6C hash      0x70 group name
```

| Code | Format | Textures | Notes |
|---|---|---|---|
| 0 | DXT1 | 6656 | |
| 18 | DXT1 | 499 | normal maps |
| 1 | DXT3 | 5 | |
| 2 | DXT5 | 4931 | car vinyls (liveries) |
| 3 | BC4 | 56 | one channel (noise, masks) |
| 17 | BC5 | 2255 | normal maps: x in red, y in green |
| 20 | DXT5 | 24 | normal maps: x in alpha, y in green |
| 10 | L8 | 3456 | grey, uncompressed |
| 11 | 16-bit | 79 | lighting data |
| 9 | BGRA8 | 191 | uncompressed |
| 13 | RGBA16F | 2 | not decoded yet |

Each format was checked by looking at the decoded pictures. Mip sizes follow the block size (4x4 blocks of 8 or 16 bytes); uncompressed rows take at least 4 bytes (a 2x2 L8 level is 8 bytes). With these rules, rebuilding the header for the same size is byte-identical for all 17,988 plain 2D textures (`node fb2_tex_import.js selftest`). A texture can be made bigger than the original: a 2048x2048 car vinyl (the original is 1024) works in the game.

### 3D models (MeshSet, res type `49b156d4`)

```
header   0x10 / 0x20 bounding box min / max      0x30 LOD pointers (up to 5)     0x58 / 0x60 name, short name
LOD      +0x04 section count   +0x08 sections    +0x40 flags (0x40 = geometry in a chunk)
         +0x48 index bytes     +0x4C vertex bytes +0x54 chunk GUID   +0x68 inline geometry
section  +0x08 material name   +0x14 triangles   +0x18 first index   +0x1C vertex offset   +0x20 vertex count
         +0x34 16 x [usage, format, offset, stream]   +0x74 stride
```

- **Geometry:** the vertices of all sections, then 16-bit indices; 16-byte aligned. Models with 8 LODs keep the geometry inline (chunk GUID 0), one LOD after another from `+0x68`. A relocation table sits at the end of the res.
- **Vertex data** (half floats): position (usage 1), normal (6), tangent (7), uv0 (0x21), uv1 (0x22), bone index (2, four equal bytes: rigid parts), vertex colour (0x1E), damage cell (0xF1), a constant 1.0 (0xF2), binormal sign (9).
- **Cars:** every part is a model `<car>/kits/<car>_kit00_stream_mesh<part>` (body, bumpers, doors, hood, …); other body kits (`kit01v`, `kit03v`) and hood/exhaust variants are separate models. Wheel positions come from `RaceWheelComponentData.Transform` in the kit ebx. Traffic cars, brake discs and calipers keep their wheels as bone groups at the origin. The damage res (`11f603c1`) does not refer to vertices, so models can get new vertices.
- `fb2_mesh.js selftest` reads and rewrites every model of the game byte-for-byte; a `.glb` export imported back unchanged gives identical models.
- **At most 65,536 vertices per section** (16-bit indices). A detailed model has to be spread over several sections or simplified.
- **uv1 is a mask layout**, not a second texture layout: car paint samples `<car>_mask` (128×128: dirt, damage and shading in R/G/B) with it. The roof and the sides are separate islands with black gaps between them. A new vertex without its own uv1 takes the uv1 of the nearest original vertex **facing the same way**. A triangle whose corners still land on different islands gets one place for all its corners. Otherwise it stretches across a gap and shows zigzags and dark stripes, the same in races and in the garage.
- **Section names differ between body kits**: the spare chrome part is `CHROME_LEFT` in `kit00`, `CHROME_TOP` in `kit01v`, `CHROME_RIGHT` in `kit03v`. Match sections by family (`CHROME_*`), not only by exact name.
- **Left and right:** a glTF car facing +z has its left side at +x, and so does the game (the driver and the `LEFT` light markers of a left-hand-drive car are at +x). Models exported from the game come back the same way. A model from elsewhere must be mirrored once on import, or text on it reads backwards.

### Car liveries and body colour

A livery is an ebx `<car>/liveries/<car>_<name>` (`NfsVehicleLiveryData`):

- **`PaintInstanceData`**: shader parameters for each car shader (`Car_Vinyl`, `CarPaintMisc`, `Wheel`, `Headlight`, …). `paintColor` is the body colour as linear RGB (for example `1, 0.036, 0.002` = red); the others set gloss and reflections (`Smoothness`, `SpecularPower`, `EnvPowFacing`, `VinylSmoothness`, …).
- **`VinylTexture`**: a DXT5 texture painted over the body colour. Where its alpha is 0 the paint shows; where it is 255 the picture shows. Stock liveries are almost fully transparent (only stripes and logos are opaque).
- The vinyl is mapped by the model's **first UV set (uv0)**, not uv1. In Blender this is the first UV map, which the `.glb` export and import carry, so a new model and its livery go into the game together.

Verified in the game: a blue `paintColor` with a transparent vinyl holding a white centre stripe and squares placed by uv0 on the doors.

The **garage** does not use that picture. It builds its preview from vinyl templates (`vinyls/<car>_<name>`, `NfsVinylTemplateAsset` → `textures/vinyls/<car>/<name>`, `NfsVinylTextureAsset`): a stack of layers, each a 512×512 L8 mask `<name>_<n>_win32` plus a fill colour (`Effects[0].Color0`, picture colour / 255). The masks are inverted (black = the layer is here), the last layer is on top, and the garage lays the result by uv0 **upside down**. All of this was confirmed in the game with coloured test bands.

More about liveries, all confirmed in the game:

- **Where no layer is, the garage shows the body colour** (`paintColor`). So the background of a picture needs no layer: set it as the body colour and give every layer to the decals. A template with a single layer can still show black lettering on orange paint.
- **A template can hold several items** (`NfsVinylTemplateItem`: Texture, Translation, Scale, Rotation, FlipHorizontal/Vertical). Some cars have one item over the whole body. Others add small, rotated or mirrored copies at the sides. A full-body picture placed into a small item shows as stray zigzags. Keep one item at `Translation 0.5, 0.5`, `Scale 1, 1` and remove the others from `Vinyls`.
- **Some vinyl textures are shared** between cars' templates (logos, NFS editions). Change only the ones a single car uses.
- **Plain colours have no picture**: about half of a car's liveries (`pp_stock_*` and others) have `VinylTexture` = null, and their bundle has no picture. Each body kit offers its own set of colours, so with a new model "some colours show the livery, others do not". To give them the picture: set `VinylTexture` to `{ "ref": "<a vinyl texture>" }`, copy the `Car_Vinyl` paint settings of a livery that has a picture (`VinylSmoothness`, `VinylSpecular`, …), and copy the picture into the colour's bundle with an `add` change.

### Porting a car model (fb2_carport.js)

Puts a whole car model from a `.glb` onto a car of the game, so it drives, crashes and shows up in the garage like the original. Verified in the game with a complete car: body, crash damage and loose parts, breaking glass, headlights and rear lights (tail, brake, reverse), interior, its own livery in races and in the garage.

```bash
node fb2_carport.js --game "<game dir>" my_ports/<name>/port.json   # writes my_ports/<name>/mod
node fb2_mods.js install my_ports/<name>/mod
```

`port.json` names the car of the game that is replaced, the `.glb`, its scale and which pieces of the model are what (rules on piece and material names). Everything else is automatic:

- **Lined up** with the car's wheels; **every body kit** and hood/exhaust variant of the car gets the model.
- **Split into the car's parts** (`"split"`): each triangle goes to the part (hood, doors, bumpers, ...) whose original vertex is nearest, so it gets that part's bones and damage. `"near"` keeps big panels off small moving parts.
- **Glass** in the glass layer and in both crack layers (`"copies"`); **headlights** in an opaque part plus the glow layer (the game's headlight shader is see-through).
- **Textures**: the car's own textures (headlight, rear lights, interior, details, wheels) get the model's pictures, packed into atlases; glow masks follow the original's channel scheme (front: red = blue; rear: red tail, red + blue brake, green reverse); alpha keeps the original's strength. Textures shared with other cars are never changed.
- **Lights**: flare and light markers are moved onto the model's lamps (`"lights"`).
- **All paint jobs** of the car are replaced: race liveries (the model's paint picture by uv0, 2048), garage templates (the picture split into the layer colours) and body colours. The paint material is found by name, or it is the material covering most of the body.
- **Wheels** (`"wheel": true`): one front and one rear wheel cut out and moved to the origin like the game's wheel models.
- **Size limits**: triangles are counted per section while they are handed out. A full section (55,000 vertices, leaving room for the copies the importer adds) passes the rest to the rule's `"spill"` sections of the same part, and then to the nearest part with room.

**Automatic mode.** Players do not have to write `port.json`. Option **C** in `manage_mods.bat` asks for a `.glb` and a car, then builds and installs the mod. The same from the command line:

```bash
node fb2_carport.js --game "<game dir>" auto my_ports/<name>/model.glb <car id>   # writes port.json, then the mod
```

It works out:
- **The size**: from the wheelbase when the model has tyres (models come in metres, centimetres, inches, feet and odd units), otherwise from the length.
- **Which end is the front**: from headlight names, red/rear lamps, or the cabin glass.
- **What every piece is**, from object and material names, transparency, colour and place:
  - paint: the biggest surface named like paint;
  - trim, underbody (`CHASSIS`), glass, lamps, red lenses, interior;
  - tyres at the four corners, rims and unnamed wheel faces inside them;
  - brakes and decals left out.

It prints a list by category and `CHECK:` lines for anything it was not sure about. A `port.json` it wrote can be edited and run again.

Tested models (Sketchfab, kept out of this repository):

| Model | Game car | Triangles | Result |
|---|---|---|---|
| BMW M3 GTR (Most Wanted) | Chevrolet Camaro SS 1967 | ~80k | works in the game: body, crashes, glass, lights, interior, livery in races and garage (hand-written `port.json`) |
| Nissan Skyline R34 (Underground) | Nissan Skyline GT-R R32 | ~80k | works in the game with `auto`, wheels included; decals on every colour and body kit |
| Ford Mustang "Hoonicorn" | Ford Mustang Boss 302 1969 | 313k | builds with `auto` (odd units, 200k triangles of trim spread over the car); **not checked in the game** |

**Ideas for whoever continues:**
- Decals made as separate geometry over the paint (the Hoonicorn's stickers) are dropped or become trim. They could be baked into the livery picture by projecting each sticker triangle onto the nearest paint surface's uv0.
- A model too heavy even with spilling could be simplified automatically (quadric edge collapse) down to the section limit.
- Interiors with tiled UVs come out flat (the atlas keeps one tile).
- The model goes into every level of detail, so many cars with very heavy models may cost frame rate.
- Hoods and doors are taken by nearest original vertex (`"near"`). A model whose hood is very different (an engine through it) ends up with the hood in the body, so it does not come off in crashes.

Do not publish models taken from other games: share the `port.json`, and let every player use their own copy of the model. The `my_ports/` folder is ignored by git for this reason.

### Files

| File | What it does |
|---|---|
| `enable_devmenu.bat`, `disable_devmenu.bat` | One-click developer menu unlock / undo (ask for administrator rights) |
| `install_mod.bat`, `manage_mods.bat`, `apply_mods.bat`, `restore_game.bat` | Install a dropped `.nfsmod`, apply enabled mods, restore the original game (ask for administrator rights) |
| `editor.bat`, `fb2_editor.js`, `editor/index.html` | Asset browser and value editor in the web browser; saves `.nfsmod` mods |
| `fb2_game.js` | Finds the game folder: registry, usual folders, or a folder picker; remembered in `game_path.txt` (a `--game` option is used once and not remembered) |
| `fb2_mods.js` | Mod manager: `.nfsmod` format, install/enable/disable/remove, conflict check, apply (with a build cache), pack, car model porting from the menu |
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
| `fb2_texture.js` | Texture header parser and decoder for every format the game uses (DXT1/3/5, BC4, BC5, L8, BGRA8, …), writes PNG |
| `fb2_tex_import.js` | PNG to texture import for the same formats: any size, mip levels, new header; `selftest` checks the header rules on every texture |
| `fb2_mesh.js` | 3D models: MeshSet reader/writer, `.glb` export (one model or a whole car) and import (new vertices, all LODs, bounding box); `selftest` checks every model |
| `fb2_carport.js` | Ports a whole car model from a `.glb` onto a car of the game (parts, bones, glass, lights, textures, all paint jobs, wheels) and writes a mod; `auto` writes the `port.json` itself |
| `fb2_repack.js` | Write support: lossless DbObject/TOC writer, zlib block packer, `.sb` append, bundle header reader/writer, bundle rebuild, adding assets to a bundle, delta bundles, self-test |
| `fb2_patch.js` | Mod loader: `apply --package <dir>` builds the `Update\Mods` package; the older in-place mode (`apply`/`restore` with backups) is kept for migration and research |

Notes on the format, as found in this game: EBX header fields are 32-bit (unlike Battlefield 3). On PC, ebx instances are `[GUID][data]` packed with at most 4-byte alignment. Chunk GUIDs in bundle tables have their first three fields byte-swapped. Video and audio chunks are stored uncompressed.

## Findings

- **`Level_1200_BlackCanyon`** is a cut level. The audio bundle registry lists 24 levels: the 23 shipped ones plus Black Canyon, which sits between `1100_MillionDollar` and `1300_IndependencePass`. Only its sound bundle remains (a construction digger sound). There is no level data and no text for it.
- A **developer main menu** (`frontenddevgraph`) with *Start Free Roam*, *Free Roam Online*, Chapter/Stage Select and test screens. Its DEBUG entry was documented earlier by [The Cutting Room Floor](https://tcrf.net/Need_for_Speed:_The_Run); this project switches it on without editing game files, and **Free Roam works**.
- A **debug menu** (max speed, infinite health, jump cheat, no collision, teleport), an **unlock-all menu** and **QA tools**.
- **Demo and E3 leftovers**: demo menus, Japanese demo screens, `e3_pause`, the "demo expired" screen.
- Working names of shipped tracks: `deathvalley`, `panamintsprings`, `zioncanyon`, `yosemitenorth`.

## Thanks and related work

This project builds on what others found before it, and it is not the only place where The Run is modded:

- **Frostbite 2 research from the Battlefield 3 era** (Frankelstner's dump scripts and the community around them): TOC decryption, DbObject, bundles and ebx were first worked out there.
- **NicknineTheEagle**: Frostbite scripts that dump the files of Frostbite 2 games, The Run included.
- **379Felipe**: a model dumper for the game.
- **[mRally2 — The Run Tools & Research](https://github.com/mRally2/The-Run-Tools-Research)**: the community hub for this game, with tools, research files, EBX dumps and many mods (car rosters, liveries, Drift Attack, unreleased events, a debug menu mod).
- **[The Cutting Room Floor](https://tcrf.net/Need_for_Speed:_The_Run)**: documented the hidden DEBUG menu first.
- **[BadassBaboon — NFS The Run Definitive Edition](https://github.com/BadassBaboon/NFS-TheRun-DE)** and **ThirteenAG — Fusion Fix**: fixes for modern PCs (frame rate and more).

What this project adds is the **write** side, as tools for players:
- mods in a separate update package, without touching the game files;
- a full ebx writer, bundle and delta bundle writers;
- importing models back with their damage and bones;
- the livery system;
- porting whole cars.

## Author

Made by **denchik777** (GitHub [denchik777imaginarysecond](https://github.com/denchik777imaginarysecond), Reddit u/Imaginary-Second9581): the research, the file format work, the mod system and the editor. The findings were first published on Reddit.

If you use this code or its format notes in your own project, please credit **denchik777** and link this repository (the MIT license asks you to keep the copyright notice).

## Disclaimer

Not affiliated with Electronic Arts or Black Box. Need for Speed and The Run are trademarks of their respective owners. This project contains no game assets. It adds a folder to your own game installation (`Update\Mods`) and does not change the original game files, but use it at your own risk.

## License

[MIT](LICENSE)
