# Vendored pixelfx

Source: https://github.com/patch-gg/pixelfx

Pinned commit: `a84159688af3ca37a4be05a0d422b94451b2e24e` (0.3.0).

The unmodified `src/`, `tools/lib/`, package metadata, LICENSE and NOTICE are vendored. `catalog.json` is generated from the metadata exported by `src/fx/index.js`; it does not include instructions from the upstream skill or plugin. `vendor.lock.json` hashes the selected files and generated catalog. No upstream scripts, install hooks, gallery images or restricted `gallery/fonts` assets are installed or run by the Agent.

Runtime integration is maintained in `server/pixelfx*.ts`, `tooling/creative/render-pixelfx.mjs` and `skills/defold-game/assets/pixelfx.lua`. The renderer streams straight RGBA into paged PNGs, without the extra compositing step in upstream `spriteSheet()`; this preserves translucent light when Defold blends it. Imported projects and HTML5 exports include upstream LICENSE/NOTICE and resource provenance.
