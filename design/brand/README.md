# Fermentrack RS identity

Flask and wordmark source assets for the Fermentrack RS interface.

- Forest: #223E35; sage: #B2C79D; white: #FFFFFF. RS uses copper #A65331 on light surfaces and pale copper #E9B28B on forest/dark surfaces.
- `flask.svg`: currentColor mark. The source is Lucide FlaskConical.
- `wordmark-light.svg`, `wordmark-dark.svg`: transparent lockups for light/dark
  surfaces. `wordmark-forest.svg`: the forest-background lockup. The 440 × 96
  lockups append the original RS mark. Main text is editable and specifies Inter
  Bold with a fixed text length; provide Inter when rendering, or outline for print.
- `rs.svg`: original geometric RS lettering, with a restrained 12-degree forward
  slant. These are RS-owned letterforms, not a traced automotive logo or font.
  The shared `ui/src/brand.tsx` component uses the same vector paths across login,
  navigation and the top bar. Accessible names always read “Fermentrack RS”.
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
The flask-only favicon remains legible at 16 pixels; its SVG title identifies
Fermentrack RS. Brand/app names include RS; references to the upstream project
and legacy import formats retain the name Fermentrack.

RS also nods to Rust and Rennsport, as explained in README.md. Upstream flask/icon
attribution remains intact; the RS lettering is GPL-3.0-only RS artwork.

The shared header has been visually checked at 320, 768 and 1440 pixels in light
and dark themes, including mobile setup/login. Keep these layouts in mind when
changing spacing or replacing assets.
