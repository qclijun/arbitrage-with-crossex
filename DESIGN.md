---
name: Arbitrage with CrossEx
description: A local, dark trading terminal for Boros and CrossEx funding-rate arbitrage, built on the Boros design-system tokens.
colors:
  ink-950: "#090D18"
  ink-900: "#0F1421"
  ink-850: "#1C212D"
  ink-800: "#1A2537"
  ink-700: "#374B6D"
  ink-600: "#48638F"
  ink-500: "#667FA7"
  ink-400: "#7B94BD"
  ink-300: "#9DAFCD"
  ink-200: "#BFC8DF"
  ink-100: "#DAE1EC"
  ink-50: "#FFFFFF"
  wash: "#BFCBDF"
  grass: "#1BE3C2"
  guava: "#FF9393"
  gold: "#F0CE74"
  warning: "#EFB54B"
  info: "#6079FF"
  pastel-blue: "#8396FF"
  link: "#7AB7FF"
  crossex: "#4BE7FF"
  tooltip-ground: "#1B202C"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.1
    fontFeature: "'cv11', 'ss01', 'tnum', 'lnum'"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: "24.2px"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "16.94px"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "14.52px"
    fontFeature: "'cv11', 'ss01'"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: "12.1px"
rounded:
  sm: "2px"
  DEFAULT: "5px"
  xl: "10px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "2.5": "10px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
components:
  button-primary:
    backgroundColor: "{colors.info}"
    textColor: "{colors.ink-50}"
    typography: "{typography.body}"
    rounded: "{rounded.DEFAULT}"
    padding: "0 16px"
    height: "36px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink-50}"
    typography: "{typography.body}"
    rounded: "{rounded.DEFAULT}"
    padding: "0 16px"
    height: "36px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.guava}"
    rounded: "{rounded.DEFAULT}"
    padding: "0 16px"
    height: "36px"
  button-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink-200}"
    rounded: "{rounded.DEFAULT}"
    padding: "0 8px"
    height: "24px"
  input:
    backgroundColor: "{colors.ink-950}"
    textColor: "{colors.ink-300}"
    typography: "{typography.body}"
    rounded: "{rounded.DEFAULT}"
    padding: "8px 12px"
  chip:
    textColor: "{colors.ink-200}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "3px 6px"
  card:
    rounded: "{rounded.DEFAULT}"
  modal:
    backgroundColor: "{colors.ink-950}"
    rounded: "{rounded.xl}"
    padding: "20px"
  tooltip:
    backgroundColor: "{colors.tooltip-ground}"
    textColor: "{colors.ink-50}"
    typography: "{typography.body}"
    rounded: "{rounded.DEFAULT}"
    padding: "6px 12px"
---

# Design System: Arbitrage with CrossEx

## Overview

**Creative North Star: "The Night Desk"**

A trading desk after hours. The ground is deep water navy, dead even and unlit, so the only light on screen comes from numbers that matter: a mint APR, a coral short leg, a gold fixed rate, one blue button that starts something. Chrome stays quiet. Panels are hairlines over translucent fills, not slabs, so they nest without each level going darker.

The desk is dense because the operator is expert. Type runs small (12px body) and exact. Columns align on Inter's tabular numerals, and nothing is set in a mono face. Color carries meaning, never decoration: if a value is tinted, it is long, short, fixed, cautionary, or actionable. Calm is the default state, so when a guava alert or an UNHEDGED banner appears it is unmistakable.

The tokens are the Boros design system's, carried on the house `ink` names in `web/tailwind.config.cjs`. They stay aligned with Boros and Pendle's open-source identity. Do not drift into a private palette.

**Key Characteristics:**
- One flat, deep-water ground (`ink-950`); no glow, no texture, no gradient field.
- Depth is a hairline (`ink-700`) over a 5% `wash` fill. There are no drop shadows on surfaces.
- Inter only, 12px body, tabular lining numerals in every figure column.
- Four semantic colors (grass, guava, gold, info) and nothing else bright.
- Outline by default; a solid fill marks the single primary action.

## Colors

A cold blue-grey water ramp holds everything; four Boros semantic hues are the only voices.

### Primary
- **Info** (`info`): the action and selection blue. It is the solid fill of the one primary button, the active-tab underline, focus accents on checkboxes, and count badges at 18% fill. **Pastel blue** (`pastel-blue`) is its lifted hover and link variant.

### Secondary
- **Grass** (`grass`): long side, positive PnL, APR, "Hedged". The strongest color on a row is usually the grass APR.
- **Guava** (`guava`): short side, negative PnL, close/reduce intents, act-now alerts.

### Tertiary
- **Gold** (`gold`): fixed rate and costs you are paying but need not act on. **Warning** (`warning`) is a shade deeper, for caution tags only.
- **CrossEx** (`crossex`): means "via CrossEx" and nothing else. Never substitute it for info.
- **Link** (`link`): inline links in prose.

### Neutral
- **Ink 950** (`ink-950`): page ground, input ground, sticky table headers, modal ground.
- **Ink 900 / 850** (`ink-900`, `ink-850`): opaque grounds for drawers, popovers, and menus that must not let the page through.
- **Ink 800** (`ink-800`): row hover and quiet dividers.
- **Ink 700** (`ink-700`): the standard hairline on cards, buttons, tables, and tabs.
- **Ink 600** (`ink-600`): input strokes, placeholders, separators (lifted to 3:1).
- **Ink 500 / 400** (`ink-500`, `ink-400`): secondary text at 10-12px (lifted to at least 4.5:1).
- **Ink 300** (`ink-300`): table headers, input text, selected segment text.
- **Ink 200 / 100 / 50** (`ink-200`, `ink-100`, `ink-50`): body text up to pure white for headline figures.
- **Wash** (`wash`): the translucent surface color. Every 5%, 10%, or 15% fill and faint hairline is an alpha of wash, not of ink.

### Named Rules
**The Semantic Four Rule.** Grass, guava, gold, and info each mean one thing. A color appears only when the value is that thing; never use one as decoration or for brand flavor.

**The Contrast Floor Rule.** Ink 500 and 400 stay at or above 4.5:1 on ink-900/950, and ink 600 at 3:1. Do not swap in the raw Boros ramp values that fail the floor.

**The Never by Color Alone Rule.** Every alert severity and leg side pairs color with an icon, a word (LONG/SHORT, Hedged), or position.

## Typography

**Body Font:** Inter, self-hosted variable (200-700), with ui-sans-serif, system-ui fallback.

**Character:** One typeface doing every job. Hierarchy comes from size and weight steps on a tight 10-28px scale; numerals align with `tabular-nums lining-nums` (the `.num` class), never a monospace pairing.

### Hierarchy
- **Display** (600, 28px, 1.1): hero figures such as Total PnL, APR, and capital on strategy cards.
- **Headline** (700, 20px, 24.2px): modal titles.
- **Title** (500, 14-16px, 16.94-19.36px): leg capsules, asset names, section heads.
- **Body** (400, 12px, 14.52px): the default for everything, including table cells (12.5px), buttons, inputs, and table headers.
- **Label** (600, 10px, 12.1px): chips and tags; 9.5px in dense rows. LONG/SHORT side markers may be uppercase; everything else is sentence case.

### Named Rules
**The Tabular Figure Rule.** Every number that can sit in a column carries `.num`. A figure that shifts width when it updates is a bug.

**The Sentence Case Rule.** Tabs, table headers, and buttons are sentence case, with no uppercase tracking. The column name is meant to be read, not to act as a rule.

## Layout

Desktop only. Content sits in a centered 1500px column with 20px side gutters and a 20px gap; the tab strip mirrors that grid so its rule and the content share one left edge. A sticky header holds two bands: the account row (brand, status strip, settings) and the tab strip, plus any rollover banner, so maturity news stays visible on every tab. The header uses `ink-950` at 88% with a backdrop blur.

Spacing runs on a 4px base, dominated by 6, 8, and 12px gaps inside components and 16-20px between groups. Rows are dense (8-10px vertical cell padding). Primary tabs (Opportunities, Positions) are set larger and split from the secondary tabs by a short vertical hairline. Order tickets and wizards overlay as a right drawer or modal; there is no permanent side column.

## Elevation & Depth

Flat by default. Depth is tonal: a hairline over a translucent `wash` fill reads as lifted against the even ground, and nesting adds another 5% fill rather than a darker panel. Surfaces that must block the page (drawers, popovers, menus) state an opaque ink ground instead. Overlays dim the page with black at 80%.

### Shadow Vocabulary
- **Tooltip lift** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`): tooltips and hover cards only.
- **Roll nudge ring** (`box-shadow: 0 0 0 4px rgba(27, 227, 194, 0.28)`, animated): the Roll over pill's ten-second pulse, disabled under reduced motion.

### Named Rules
**The No Glow Rule.** No drop shadows on cards, no background glows, no dot grids. The even ground is what lets a 5% fill read as a surface.

## Shapes

Three radii: 2px for tags and chips, 5px for everything structural (cards, buttons, inputs, tables, alerts), and 10px for modals. Circles are reserved for the disclosure chevron and scrollbar thumbs. Borders are always 1px. Segmented controls are butted cells whose hairlines overlap by 1px, not loose buttons in a pill. Strategy legs are outlined capsules (logo, venue, direction) with no tint.

## Components

### Buttons
Quiet until it counts.
- **Shape:** 5px radius, 36px tall, 12px/500 label, 16px side padding.
- **Primary:** solid info fill, white text; hover drops to 75% info. Only the action that starts something (Open this strategy, Execute) gets it. Disabled is a flat grey fill.
- **Outline (default):** transparent with an `ink-700` hairline and white text; hover adds a 20% `ink-700` fill.
- **Danger:** the same box with a guava hairline at 60% and guava text, for actions that stop or remove.
- **Row action:** 24px tall, 11px label, half-strength hairline; quieter because it sits inside a table.
- **Hold to confirm:** irreversible wire actions use a press-and-hold button with an 18px progress ring (800ms). Keyboard activation is deliberately swallowed. Tones: info, grass (buy), guava (sell), or outline.
- **Link button:** pastel-blue underlined text at a 3px offset.

### Chips
- **Style:** 2px radius, 10px/600 label, `ink-700` hairline over a 6% wash fill.
- **Tones:** the tone at full strength on hairline and text with a 20% fill (grass, guava, warning, info). Count badges are borderless info at 18%.

### Cards / Containers
- **Corner Style:** 5px.
- **Background:** 5% `wash` over whatever is beneath; nests without darkening.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px `ink-700`. The account PnL summary uses an info hairline at 60% over a 6% info fill as its one highlighted container.
- **Alerts:** three grounds with the same recipe, a tinted hairline over a 10% fill. Info for FYI, gold for a cost you are paying, guava for act now.

### Inputs / Fields
- **Style:** `ink-950` ground, 1px `ink-600` stroke, 5px radius, 12px `ink-300` text, `ink-500` placeholder.
- **Focus:** stroke and a 1px ring both shift to `ink-300`; no glow.
- **Selects** are native, dressed as inputs with a drawn chevron. **Checkboxes** are native with an info accent.

### Navigation
- **Tabs:** sentence case on a transparent ground; the active tab turns white with a 1px info underline that scales in, plus a faint info gradient rising from the bottom edge. Inactive tabs are muted ink.
- **Segmented controls:** butted 1px cells; the selected cell gets a 15% wash fill and medium weight, not blue. Side switches tint the active cell with the side's color (grass Buy, guava Sell or Close).

### Data tables
Sticky `ink-950` headers in 12px `ink-300` regular weight; 12.5px cells; rows split by `ink-850` rules with an `ink-800` hover at 50%. Expandable rows open into a slightly darker `ink-950` panel. Unknown venue states render verbatim in the cell.

### Tooltips
Opaque `tooltip-ground` with an `ink-600` hairline, 5px radius, 12px text at 1.5 leading; the only surface with a shadow. Labels that carry a tooltip are marked by a dotted underline at a 4px offset and nothing else.

## Do's and Don'ts

### Do:
- **Do** use the semantic names (`grass`, `guava`, `gold`, `info`) in new code; the `cyan`/`emerald`/`rose`/`amber`/`sky` scales are bridge aliases slated for deletion.
- **Do** build surfaces as a 1px `ink-700` hairline over a 5% `wash` fill, and give popovers and menus an opaque ink ground.
- **Do** put `.num` on every figure and keep body type at 12px.
- **Do** reserve the solid info button for the one action per view that starts something; everything else is an outline.
- **Do** pair every severity color with an icon or word.
- **Do** keep motion short and functional, and switch off looping animation under `prefers-reduced-motion`.

### Don't:
- **Don't** add drop shadows, glows, background gradients, or textured grounds to cards or the page.
- **Don't** introduce a monospace face or a second typeface.
- **Don't** use blue to mean "selected" in segmented controls; selection reads by fill and weight.
- **Don't** uppercase tabs, headers, or buttons.
- **Don't** use `crossex` cyan for anything other than "via CrossEx".
- **Don't** use colors outside the Boros token set or lower the ink contrast floor.
