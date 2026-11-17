# Fermentrack identity

Flask and wordmark source assets for the Fermentrack RS interface.

- Forest: #223E35; sage: #B2C79D; white: #FFFFFF. Colours sampled from the supplied
  reference. Warm application surfaces and copper action buttons remain separate.
- `flask.svg`: currentColor mark. The source is Lucide FlaskConical, also used by
  the first implemented UI, rather than a newly drawn approximation.
- `wordmark-light.svg`, `wordmark-dark.svg`: transparent lockups for light/dark
  surfaces. `wordmark-forest.svg`: the forest-background lockup. Text is editable
  and specifies Inter Bold; provide Inter when rendering, or outline for print.
- `favicon.svg`: flask-only browser/app mark, forest tile with sage strokes.
- `favicon.ico`: 16, 32 and 48 pixel sizes. `favicon-{16,32,48}.png`: browser sizes;
  `favicon-180.png`: Apple touch icon candidate; 192/512 PNGs: app-icon candidates.
  Maskable-icon acceptance has not been performed; do not mark them maskable.
- `icons/`: source SVGs for the consistent Lucide interface family. Use a 24 px
  grid, 1.75 px stroke, rounded caps/joins. Brand flask uses a 2 px stroke before
  scaling. The flask denotes the product; Beer denotes batches, Refrigerator
  equipment and LayoutDashboard the overview.

Lucide source: installed lucide-react 0.468.0. `LICENSE-lucide.txt` retains its ISC
notice and Feather attribution. PNGs were rendered from the SVG in Chromium;
ICO was generated from the rendered PNG. All output dimensions were verified.
