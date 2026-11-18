# YeastCraft identity

The shared flask and YeastCraft wordmark identify the app on desktop and mobile.

- Forest: #223E35; sage: #B2C79D; white: #FFFFFF.
- `flask.svg`: currentColor mark derived from Lucide FlaskConical.
- `wordmark-light.svg`, `wordmark-dark.svg`: transparent lockups for light/dark
  surfaces. `wordmark-forest.svg`: forest-background lockup. These 360 × 96 SVGs
  use editable Inter Bold text; provide Inter when rendering or outline for print.
- `ui/src/brand.tsx`: shared flask/wordmark for navigation, login and header.
  The accessible name is “YeastCraft”.
- `favicon.svg`: flask-only browser/app mark, forest tile with sage strokes.
  The matching ICO and PNG variants retain the same flask, including the Apple
  touch icon. No lettering is embedded in these raster assets.
- `icons/`: Lucide interface icons on a 24 px grid with rounded caps/joins.
  The flask denotes the product; Beer denotes batches, Refrigerator denotes
  equipment and LayoutDashboard denotes the overview.

Lucide source: lucide-react 0.468.0. `LICENSE-lucide.txt` retains its ISC notice
and Feather attribution. Keep the mark legible at 16 pixels and the shared header
within the viewport at 320, 768 and 1440 pixels in both themes.
