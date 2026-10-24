# Bundled visual dependencies

TikZJax assets were retrieved from the official distribution on 2026-10-24.
`manifest.json` records their original URLs and SHA-256. The renderer, WASM and
compressed core are unmodified. ChatPDF's worker adapter is separate source.

TikZJax: Jim Fowler and contributors, https://github.com/kisonecat/tikzjax .
LPPL 1.3c, reproduced in `LICENSE.md`. The complete upstream source/build
environment is available at that repository. Its core includes upstream
TeX/LaTeX/TikZ resources.

BaKoMa fonts: Copyright 1994, 1995 Basil K. Malyshev. Unmodified font files from
https://tikzjax.com/bakoma/ttf/ include the full permission notice in
`fonts/LICENSE.txt`. Original collection: https://ctan.org/pkg/bakoma-fonts .

Mermaid is a separately pinned npm dependency.
Its license is reproduced in `MERMAID-LICENSE.txt`.
Copyright/license banners for bundled dependencies remain in generated scripts.
