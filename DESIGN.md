# KINETIC Design

This is the visual direction for the KINETIC web app (`web/`). It describes how things should look and behave. It does not change the stack, routes, copy or product behaviour.

- **Stack stays as is:** React 18 + Vite + TypeScript, plain CSS (`styles.css`, `theme.css`, `pages.css`, `product.css`, then `design.css`, which is loaded last and carries this design), `lucide-react` icons, hash routing through `useRoute()` / `go()` in `live.tsx`.
- **Routes stay as is:** the website has `#/` (landing) and `#/models` (with `#/models/search/<query>` and `#/models/<key>`). Everything you operate opens in the console (§5A): `#/console` (overview), `#/run`, `#/jobs`, `#/providers`, `#/publish`, `#/creators`, `#/audit`, `#/docs`, `#/earn`. Old `#/provide` links land on Earn's provider tab.
- **Data stays real:** every number on screen comes from the live snapshot, or from the labelled synthetic replay. The design never adds placeholder figures, savings claims or invented proof.

> **Update 2026-11-06: Akash reference layer.** The website and console now take their layout and visual language from the Akash Network website (MIT, github.com/akash-network/website), used as a reference, not copied: see §5E. Where §1–§5D disagree with §5E (fonts, greys, gold values, pill controls, landing sections), §5E wins. §5F carries the same language into Models and every console page, and wins over §5A–§5C.

---

## 1. Identity

Use a dark page (black on the landing page, navy-black elsewhere) with warm orange actions and pale gold numbers. Thin hairlines separate opaque panels. Statements are set in a clear sans-serif and data in a monospace. Warm light is kept to a few important places: the closing area and the primary actions.

In one line: **a calm, dark control room for verified AI work, with warm light only where you act or where the important number is.**

---

## 2. Tokens

These are the authoritative values. They live in `:root` in `web/src/design.css`, which loads last and points the existing tokens at them, so the current components pick up the new look without being rewritten.

| CSS variable | Value | Use |
| --- | --- | --- |
| `--dp-color-ground` | `#07090e` | Page background, darkest field |
| `--dp-color-ground-tint` | `#101522` | Restrained navy shift (gradients, closing field) |
| `--dp-color-panel` | `#10141c` | Opaque content surfaces |
| `--dp-color-accent` | `#ff951f` | Primary actions, selection, active nav |
| `--dp-color-value` | `#edcd8c` | Important numbers, small diagram marks |
| `--dp-color-ink` | `#f4f5f7` | Main text |
| `--dp-color-ink-muted` | `#c9ced8` | Paragraphs, labels |
| `--dp-color-line` | `#303139` | Panel borders, rules |
| `--dp-typography-body-face` | `"Financial Plex Sans", sans-serif` | Display and reading |
| `--dp-typography-data-face` | `"Financial Plex Mono", monospace` | Data, ids, metadata |
| `--dp-typography-body` | `16px` | Body |
| `--dp-typography-supporting` | `14px` | Supporting text |
| `--dp-typography-metadata` | `13px` | Metadata, tags |
| `--dp-typography-body-leading` | `1.6` | Default line height |
| `--dp-typography-reading-leading` | `1.65` | Long-form paragraphs |
| `--dp-spacing-cluster-gap` | `24px` | Between grouped blocks |
| `--dp-spacing-compact-gap` | `12px` | Inside groups |
| `--dp-radius-panel` | `5px` | Panels, cards |
| `--dp-radius-editorial` | `4px` | Images |
| `--dp-radius-control` | `40px` | Buttons, inputs, the floating header |
| `--dp-border-hairline` | `1px` | All borders |
| `--dp-motion-interaction` | `160ms` | Hover, focus and press transitions |
| `--dp-motion-easing` | `ease` | Easing for the above |

### Mapping onto the existing tokens (`design.css`)

| Existing token | New value |
| --- | --- |
| `--bg` | `var(--dp-color-ground)` |
| `--bg-2` | `var(--dp-color-ground-tint)` |
| `--panel` | `var(--dp-color-panel)` |
| `--panel-2` | `#161b26` (a step lighter, for hover and nested surfaces) |
| `--rule` | `var(--dp-color-line)` |
| `--rule-2` | `#3c3e48` (stronger hairline for control borders) |
| `--ink` | `var(--dp-color-ink)` |
| `--ink-2` | `var(--dp-color-ink-muted)` |
| `--action` (new) | `var(--dp-color-accent)`: orange for buttons, links, focus, active toggles and selection |
| `--link` | `var(--action)` |
| `--accent` | **unchanged teal `#7ad8c1`**. Across the app it means "verified / good" (tags, check marks, live dot), so it is not turned orange |
| `--font`, `--mono` | `var(--dp-typography-body-face)`, `var(--dp-typography-data-face)` |
| `--on-ink` | `var(--dp-color-ground)` (dark text on orange buttons) |
| `--focus` | `rgba(255, 149, 31, 0.6)` |
| `--r` | `var(--dp-radius-panel)` |

Status colours keep their meaning and are not replaced by orange:
- **Verified / passed:** keep a green-teal (the current `#7ad8c1`) for `Tag tone="good"` only.
- **Warning:** keep amber `--warn`.
- **Slashed / failed:** keep coral `--bad`.
- Orange means "you can act here" and is never used to mean "good" or "bad".

---

## 3. Typography

- **Faces:** IBM Plex Sans for display and reading, IBM Plex Mono for data, loaded from Google Fonts in `index.html` in place of Inter / JetBrains Mono. The face tokens list `"Financial Plex Sans"` / `"Financial Plex Mono"` first and fall through to `"IBM Plex Sans"` / `"IBM Plex Mono"`, so a self-hosted alias can be dropped in later without touching any component.
- **Hero title:** medium weight (500), tight tracking (`-0.02em`), line height about `1.02`, scaling `clamp(44px, 4.8vw, 64px)` on wide screens, `40–52px` at 1100px and below, `36–46px` at 800px and below, and `32–38px` at 520px and below.
- **Section headings (h2):** weight 500, 28–36px, tracking `-0.01em`.
- **Main values** (KPIs, prices, refund totals): Plex Mono, `font-variant-numeric: tabular-nums`, coloured `--dp-color-value`. The unit (ℏ, "chunks", "GPUs online") is set smaller, in `--dp-color-ink-muted`.
- **Paragraphs:** `--dp-typography-body` with `--dp-typography-reading-leading`, maximum width about 64ch.
- **Ids, hashes, transaction links:** Plex Mono at `--dp-typography-metadata`.

---

## 4. The floating header (pill navigation)

The current full-width `.topbar` becomes a **floating, fully rounded pill** that hovers above the page.

### Shape and placement
- `position: sticky; top: 16px;`, centred, `width: min(1152px, calc(100% - 32px))` (the page's content width), `margin: 16px auto 0`.
- `border-radius: var(--dp-radius-control)` (40px), so each end is a full semicircle.
- Height 56px, inner padding `0 8px 0 20px`.
- Background `rgba(16, 20, 28, 0.86)` (the panel colour), `backdrop-filter: blur(12px)`, and a hairline border `1px solid var(--dp-color-line)`.
- A soft shadow lifts it off the page: `0 10px 30px rgba(0, 0, 0, 0.45)`. Do not use a coloured glow.
- `z-index` sits above page content. The landing page runs its gradient up behind the pill (`margin-top: calc(var(--hdr) * -1)` with matching padding), so the pill floats over the gradient without covering the hero.

### Contents, left to right
1. **Brand:** the `brand-mark` plus "KINETIC", which links to `#/` (the landing page).
2. **Two toggles only:** **Models** (`#/models`, `BrainCircuit`) and **Console** (`#/console`, `MonitorCog`). Everything you operate lives under Console (see §5A). New features are added inside the console, not as more header toggles.
3. **Right cluster:** the network live dot, the synthetic replay badge when it is on, "Some data is delayed" when it applies, and `ZeroGAccount` (sign in).

### Toggle states
| State | Look |
| --- | --- |
| Default | Transparent fill, `--dp-color-ink-muted` text, 14px, weight 500, `border-radius: 40px`, padding `7px 14px`, 14px icon before the label |
| Hover | Fill `rgba(255, 255, 255, 0.05)`, text `--dp-color-ink`, transition `var(--dp-motion-interaction) var(--dp-motion-easing)` |
| Active (`aria-current="page"`) | Fill `rgba(255, 149, 31, 0.14)`, text orange, inset hairline `rgba(255, 149, 31, 0.45)`. **Console** is active on every console route |
| Focus-visible | 2px orange outline, 2px offset, always visible |

- Each toggle keeps its text label; the icon never replaces it.
- The toggles stay as real `<a href="#/…">` links with `aria-current`.

### Small screens
- **Above 640px:** both toggles stay in the pill (the base stylesheet's 900px collapse is overridden, since two toggles fit).
- **At 640px and below:** the toggles fold behind a round 40px menu button. The open menu is a rounded panel that drops below the pill. Escape closes it.
- **At 520px and below:** the pill spans `calc(100% - 16px)` at `top: 8px`. While the synthetic replay badge is showing, the "KINETIC" word is dropped (the mark and its "KINETIC home" label stay) so everything fits on one line.

---

## 5. Landing page (`#/`, `Landing.tsx`)

**Header on the landing page:** full width (content aligned to the 1152px page column), **transparent** over the hero with no border, shadow or pill shape. Once the page scrolls past 8px it takes a quiet glass background (`rgba(7, 9, 14, 0.72)`, 12px blur) and a hairline bottom border so it stays readable over content. The Models page keeps the floating pill.

The landing page is the first thing you see. It only introduces KINETIC and explains how it works. It shows **no live stats, no models list, no jobs and no activity**; those live in Models and the Console. It needs no live data, so it renders immediately, even before the network answers.

### 5.1 Background: black gradient
```css
.landing {
  background:
    radial-gradient(1100px 560px at 50% -8%, rgba(255, 255, 255, 0.07), transparent 65%), /* faint lift at the top */
    linear-gradient(180deg, #111214 0%, #000 38%, #000 70%, #0b0b0d 100%);              /* near-black → black → near-black */
}
```
- Neutral black only: no navy shift and no orange glow in the page background. The one warm light is under the closing buttons (§5.3).
- The gradient runs up behind the floating header.

### 5.2 Falling Lucide icons (decorative layer)
A sparse layer of Lucide icons drifts slowly down behind the landing content.

- **Icons:** computation and tech only: `Cpu`, `Microchip`, `CircuitBoard`, `MemoryStick`, `Server`, `HardDrive`, `Database`, `Network`, `Router`, `Cloud`, `Binary`, `Terminal`, `CodeXml`, `BrainCircuit`.
- **Size:** 20–26px, `strokeWidth={1.5}`.
- **Colour:** `--dp-color-ink-muted` at about 14% opacity; every seventh icon uses `--dp-color-value` at about 22%. Never full-strength orange.
- **Count:** 16 on desktop, 8 under 800px, none under 520px.
- **Motion:** each icon falls through the viewport over 16–28s, linear, with a small sway (±14px) and slow rotation (±20°). Positions and timings are randomised once per visit.
- **Layering:** a fixed, `aria-hidden` layer at `z-index: 0` with `pointer-events: none`, masked so it fades over the central reading column. Content sits above it.
- **Reduced motion:** the layer is hidden entirely.

> Note: the base Financial style keeps decoration static. This falling-icon layer is an intentional, user-requested exception: faint, slow, sparse, landing page only, and off for reduced motion.

### 5.2a Hexagon field (hero background)
An original hexagon lattice lit by a soft light that follows the cursor (`web/src/hexfield.tsx`, `<HexField>`). It's inspired by React Bits Pro's "Hexagonal Vault" but written for this project, with no license or new dependencies.
- **Canvas** behind the hero only, full width, running up behind the floating header. Pointy-top cells of 26px; the faint lattice (white at about 5.5%) is painted once per resize.
- **Light:** cells within 140px of the light get brighter, thicker edges, gold (`--dp-color-value`) at the core and orange (`--dp-color-accent`) at the rim, with a faint fill and a soft orange glow.
- **Follow:** the light eases toward the cursor and returns to rest when the pointer leaves. At rest it sits under the actions (76% down), so it never crosses the headline.
- **Static when idle:** it only redraws while the light is moving; there's no autoplay or continuous animation.
- **Reduced motion:** the light jumps to the cursor with no easing.
- **Legibility:** the hero text carries a soft dark halo, and the canvas fades out toward the sides and into the page below (an intersected radial and linear mask).
- The canvas is `aria-hidden` and ignores pointer events; the hero content stays fully interactive.

### 5.3 Section order

**1. Hero (single centred column)**
- Mono eyebrow `Verifiable AI hub` in gold.
- Title **"Verified AI models, run on community GPUs"**, 44–64px, medium weight, max 22ch (two lines on desktop).
- Lead: "Every result is checked. If a GPU cheats, you get refunded from its bond."
- The model search with the orange **Browse models** button.
- Links: Open the console · Rent out a GPU · Get started.

**2. What KINETIC is**
A two-column split (5:7):
- **Left:** a gold mono kicker ("Overview"), the heading, a one-sentence introduction, and a ruled "built on" strip: Payments · Hedera, Compute · Storage · 0G, State · Arkiv.
- **Right:** one ruled panel with three roles, each with an orange icon tile, a one-line description and a link: **Run AI jobs** (`#/run`), **Rent out a GPU** (`#/earn/provide`), **Publish a model** (`#/publish`).
It stacks to one column at 800px.

**3. How it works (connected process row)**

| # | Lucide icon | Title | Text |
| --- | --- | --- | --- |
| 1 | `CloudUpload` | Publish | A quorum of verifiers scans, benchmarks and signs every model. |
| 2 | `Cpu` | Run | Pay per chunk in HBAR. No servers, no downloads. |
| 3 | `ShieldCheck` | Check | Hidden known answers and 0G canaries in every job. |
| 4 | `ServerOff` | Refund | A GPU that fails its checks is slashed; you're paid back. |

- Markers are 44px circles with a hairline orange border and a 20px orange icon. The step number is mono gold. The connector is a static hairline.
- No live numbers on the steps.

**4. What every job gets (capability matrix)**
Three columns of ruled cells, each with a 20px orange icon: `MonitorCheck` Evaluate before work, `Gauge` Monitor during work, `Network` Reroute, `ShieldX` Enforce, `Database` Audit trail, `BrainCircuit` Model Passport.

**5. Closing: "Run your first verified job"**
A near-black field with **Run a job** (primary, `#/run`) and **Read the docs** (secondary, `#/docs`), and a soft orange-gold light beneath the buttons only.

**6. Footer**
Product (Models, Console), Console (Run a job, Jobs, GPUs, Publish, Creators), Learn (Docs, Audit trail). The status bar stays below it.

---

## 5A. Console (`console.tsx`): a full-screen workspace

The console isn't another page of the website. It's a professional, IDE-style workspace in the spirit of VS Code or Google Colab: one place to run jobs, watch GPUs, publish models and follow creators. The website's floating header, footer and status line are not shown inside it.

**Layout** (fixed to the viewport, nothing scrolls but the panes):

```
┌───────────── title bar: brand · command palette · Models · Website · account ─────────────┐
│ act │ explorer          │ tabs ─────────────────────────────────────── [explorer][panel] │
│ ivi │  JOBS        +    │ KINETIC › Console › Jobs › job-…                                │
│ ty  │  GPUS        +    │                                                                  │
│     │  MODELS      +    │   the open view (Overview, Run, Jobs, GPUs, Publish, …)          │
│ bar │  CREATORS         │                                                                  │
│     │                   │ ACTIVITY | PROBLEMS ──────────────────────────────────────────── │
│ ⋮   │                   │ 03:53:34 PM  closed  job-… closed · 8 chunks kept · …            │
└─────┴───────────────────┴──────────────────────────────────────────────────────────────────┘
  status bar: network · 0G · Arkiv · GPUs live · running · problems · updated · Ctrl K
```

- **Title bar (48px):** the KINETIC mark with an orange `CONSOLE` chip (links back to the website), a command palette button ("Search models, jobs, GPUs or go to…", Ctrl/⌘ K), quick links to **Models** and **Website**, the replay badge and the 0G account.
- **Activity bar (52px):** icon-only views with tooltips and labels: Overview `Gauge`, Run `SquareTerminal`, Jobs `Workflow`, GPUs `Cpu`, Publish `CloudUpload`, Creators `CodeXml`, Audit trail `Database`; **Docs** `FileCode` is pinned at the bottom, separate from the rest. The active view has a 2px orange edge. Clicking the active view again toggles the explorer, as in VS Code.
- **Explorer (272px, collapsible with Ctrl/⌘ B):** the whole workspace as a tree of native disclosures:
  - **Jobs:** the latest 12, each with a status dot and chunk progress. `+` starts a new run.
  - **GPUs:** each GPU with a status dot (teal for live, red for rejected or slashed) and its price. `+` rents out a GPU.
  - **Models:** each listed model with its benchmark score; clicking one opens Run for that model. `+` publishes a model.
  - **Creators:** each creator, opening their dashboard.
  The current item is highlighted with the orange soft fill.
- **Editor:** every view you open becomes a **tab** (up to 8, closable), with **breadcrumbs** underneath. Pages render at a comfortable reading width (max 1240px) inside the scrolling editor.
- **Bottom panel (Ctrl/⌘ J), docked and collapsed by default:** a 34px bar with the **Activity | Problems** tabs and a one-line preview of the newest event, like a terminal's last line. Clicking a tab, the preview or the chevron drops it open; the chevron folds it back, and a maximize button grows it to 55% of the height. The status bar's problems count opens it on Problems. **Activity** streams the live HCS receipts in a terminal-like log. **Problems** lists failed checks and slashes. The panel can be expanded or closed.
- **Status bar (26px):** the network segment in orange-soft (or "Synthetic replay"), 0G · Arkiv, GPUs live, jobs running, a problems count (opens the panel), last update, and a Ctrl K shortcut.
- **Command palette:** a keyboard-first dialog to go to any view, run any model, open any job or find any GPU. Arrow keys move, Enter opens, Escape closes.

**Routes are unchanged:** `#/console`, `#/run`, `#/jobs`, `#/providers`, `#/publish`, `#/creators`, `#/audit`, `#/docs` and `#/earn` all open inside the workspace. **Models** (`#/models`) stays part of the website.

**Small screens:** below 900px the explorer floats over the editor with a scrim and starts closed. Below 700px the panel is hidden and the palette becomes an icon button. Below 520px the activity bar narrows to 44px.

**Console polish:** inside the editor, pages use a tool-like density:
- 22px titles, with a hairline under the page header.
- 13–13.5px supporting text.
- 6px radii on buttons, inputs and panels (pills are for the website).
- Compact KPI tiles with 22px gold figures.
- Mono uppercase labels on panel heads and side cards.
- Solid, not dashed, empty states.

**Publish (`#/publish`):** a settings-style form instead of numbered questions:
- **Left:** one ruled panel with labelled sections (**Task**, **Identity**, **Listing**, **Licensing and royalty**). Each section has a title and help text on the left and its fields on the right.
- **Right (sticky):** a **live listing preview**, which updates as you type and carries a "Pending review" pill, and the **review pipeline** card with "Publishing as" and the **Publish model** button. Below the button is the one thing still missing, if any.

**Audit trail (`#/audit`):** one compact line per receipt in four columns (#, time, type, receipt) under a sticky column header. New receipts no longer push the list while you read: if you've scrolled down, they wait behind a sticky "↑ N new receipts" button, which reveals them and scrolls to the top. Below 700px each receipt wraps to two lines.

**Not built:** model *training*. KINETIC runs inference jobs on listed models; there's no training backend, so the console doesn't show a training feature.

### 5B. Model cards (`#/models`)
Each model is a card in a responsive grid (min 300px per column):
- A 2px top edge and faint top wash in the model's avatar colour.
- Header: large avatar, `namespace/name` (links to the model page), task and version, and a teal **Verified** pill.
- Description, clamped to two lines.
- Metrics strip: **Benchmark**, **GPUs** serving, **Jobs** run, in large gold mono figures.
- Chips: runtime, where the weights live, royalty share.
- Actions: **Run** (primary, `#/run/<model>`) and **Details**.
- Hover lifts the card 2px and strengthens its border (no lift with reduced motion).

### 5C. GPU cards (Console → GPUs)
The GPUs page shows **available GPUs as cards**, not a log-style table. Live GPUs come first, then offline, rejected and slashed; the chosen sort applies within each group.
- A 2px status edge: teal for live, coral for rejected or slashed, none for offline.
- Header: GPU icon in the provider's colour, name (with a **test** pill for adversarial test providers) and runtime.
- Price per chunk in large gold mono, with the status tag beside it. Non-live GPUs show the price in grey.
- Specs: bond, latency, earned, right now (idle or chunks in flight).
- Checks bar (passed / failed) and the model it serves.
- **Details** expands the card across the full row with every fact the old table row held (admission, model check, reputation, identity, sandbox and so on).

---

## 5D. Voice and scrollbars

- **Copy:** short, plain, professional. One idea per sentence, usually under 15 words. Page subtitles fit on one line, and help text and tooltips state the fact without narrating the mechanism. Prefer "Listed versions are immutable" over "A listed version can't change, so publish updates as a new version".
- **Scrollbars:** hidden everywhere (`scrollbar-width: none` and `::-webkit-scrollbar { display: none }` in `design.css`). Every pane still scrolls by wheel, trackpad, touch and keyboard.

## 5E. Akash reference layer (`site.css`)

The Akash Network website is the reference for each component and page. KINETIC keeps its own name, logo, content, hexagon hero and orange accent; nothing of Akash's branding, imagery or copy is used.

**Palette (one for the whole site, console included).** Near-black neutrals replace the navy tints: page `#030303` (landing hero) / `#0a0a0a`, section bands `#0d0d0e`, cards `#111112`–`#171717`, lines `#262626`–`#2e2e2e`, text `#fafafa`, body copy `#a3a3a3`, muted `#737373`. Orange `#ff951f` is the only brand colour (primary buttons, active dots, card icons, the hero badge). Teal still means verified/pass and red means failed/slashed. Numbers are white; gold is retired.

**Type.** Geist for text, JetBrains Mono for data. Headings are semibold with tight tracking (−0.025em to −0.045em).

**Shape.** Buttons, inputs and selects have 8px corners (no pills). Cards and windows 12px. Small controls (slide pills, row CTAs) are 28px tall with 6px corners.

**Header.** A 12px-radius bar with the brand on the left, Models and Console centred, account on the right. On the landing page it stays transparent and full width until you scroll.

**Landing sections, in order:**
1. Hero inside the hexagon field: badge, a plain two-line headline (no icons or hover effects), one-line subhead, model search.
2. "Built on" strip: Hedera (Payments), 0G (Compute · Storage) and Arkiv (State) as text, each with its role.
3. What KINETIC is: three roles (Run AI jobs, Rent out a GPU, Publish a model) that advance every 5 s, beside cross-fading console screenshots (`web/public/shots/`, captured from the synthetic replay). A pill of progress dots plus play/pause controls it; it only runs while on screen.
4. How it works: four numbered steps (Publish, Run, Check, Refund) beside a window that plays a short example for each step. The window is labelled "Example".
5. What every job gets: six cards in a 3/2/1-column grid.
6. Closing band: "Run your first verified job" with two actions.
7. Footer (shared with Models): link columns, then copyright and the live network line.

**Pages.** Models opens with a page heading (40px title, one-line lede, hairline). Console forms led by `.fsec-head` (Run, Earn) stack full width; the two-column settings grid is only for Publish.

**Alignment rules.** Section titles, list rows and step titles share one left edge (the showcase's active dot hangs in the margin). Filter columns start level with the list title. Timestamps sit in a fixed one-line column.

## 5F. App layer: Models and the console (`app.css`)

The same Akash-referenced language, applied to the model hub and every console page. Loaded last.

**Models (`#/models`).** Modelled on Akash's GPU pricing list. Filters are checkbox rows (box, label, count on the right), with a "Built a model worth sharing?" prompt and a Publish button under them. Models are rows, not cards, grouped under a grey pill per task. Each row has: avatar; `namespace/name` with a teal Verified mark; a two-line description; spec pills (version, runtime, weights, royalty); three stats (Benchmark, GPUs, Jobs) divided by hairlines; and a round arrow that opens into an orange "Run" button on hover or focus. On phones the stats drop under the text and the Run button stays open.

**Console shell.**
- Title bar: "KINETIC / Console" in plain text (no badge), search box, replay pill, sign-in, bell.
- Side navigation: a labelled list in three groups. Workspace has Overview, Run, Jobs and GPUs; Build has Publish and Creators; Records has the Audit trail; Docs sits at the bottom.
- Active item: grey fill, orange icon, and an orange edge.
- Below 1180px the side navigation folds to icons.
- Tabs: small rounded pills, with the open one filled.
- The breadcrumb row is gone, since the tab and page title already say where you are.
- Status bar: neutral, with a green connection dot.

**Console pages.**
- Titles are 28px semibold, with a 15px grey lede and a hairline below.
- Totals are separate 12px cards: label first, then a 28px plain number (not mono).
- Panels, side cards, GPU cards, tables and form sections all use one card: `#111112`, `#2e2e2e` border, 12px corners. Panel titles are 14px semibold in sentence case.
- Mono is only for identifiers (job ids, hashes, topics); amounts are plain text.

**Shared pieces (website and console).**
- Labels: no more mono capitals anywhere; every label is sentence case.
- Tags: a neutral pill with a status dot (green ok or live, amber warning, red failed). A tag with its own icon has no dot.
- Chips: neutral pills.
- Links: white with an underline, not orange.
- Segmented controls: a dark track with the active option filled.
- Notices: a card with an amber left edge.
- Replay badge: a neutral pill with an amber dot; on phones it shortens to "Replay".

---

## 6. Components

### 6.2 Buttons
| Variant | Default | Hover | Focus |
| --- | --- | --- | --- |
| Primary | Orange fill, `--dp-color-ground` text, `border-radius: 40px`, weight 500, padding `10px 20px` | Fill `#ffa640`, border brightens | 2px orange outline, 2px offset |
| Secondary | `--dp-color-panel` fill (or transparent), hairline border, ink text | Border `rgba(255,149,31,0.5)`, text ink | Same |
| Link | Orange text, no underline; underline on hover | | Visible outline |

- A small arrow (`ArrowRight`, 14px) may follow an action label, but the label itself carries the meaning.
- Pressed (`:active`) shifts the button down 1px and darkens the fill slightly.

### 6.3 Panels and cards
- Opaque `--dp-color-panel`, hairline `--dp-color-line`, `--dp-radius-panel`. There is no glass, no transparency and no coloured glow.
- Panel heads use a muted 13px label on the left and an orange link on the right ("All jobs →").

### 6.4 Tags and status
- Keep `Tag` and `StatusTag`, with `--dp-radius-control` pills, 12–13px mono, a soft tinted fill and a hairline in the tone colour.
- Keep the existing semantic tones (good, warn, bad, 0G).

### 6.5 Inputs
- Rounded (`40px`) search and text inputs on `--dp-color-panel` with a hairline. Focus turns the border orange and adds a 3px orange ring at 25%.

### 6.6 Disclosures (FAQ / Docs)
- Native `<details>` with hairline dividers between items and a plus/minus marker on the right.

### 6.7 Comparisons (where used, e.g. GPU offers)
- Aligned columns. A featured option has a persistent badge, and the selected option shows an orange top edge plus a pressed control state. Selection must give real feedback and never imply that a transaction happened.

---

## 7. Icons

- **Library:** Lucide (`lucide-react`) for the header, console sidebar, landing page and menu button.
- **Domain rule:** every content and decorative icon comes from the computation and tech domain: hardware (`Cpu`, `Microchip`, `CircuitBoard`, `MemoryStick`, `HardDrive`, `MonitorCog`), infrastructure (`Server`, `ServerCog`, `ServerOff`, `Database`, `Network`, `Router`, `Cloud`, `CloudUpload`), code and data (`Binary`, `Terminal`, `SquareTerminal`, `CodeXml`, `FileCode`, `Workflow`), AI (`BrainCircuit`, `Bot`), and system checks (`ShieldCheck`, `ShieldX`, `MonitorCheck`, `Gauge`). Do not use generic, finance or lifestyle icons (coins, wallets, receipts, gavels, hearts, stars).
- **Only exception:** plain UI glyphs whose meaning is the control itself: `Menu`, `X`, `ArrowRight`, `Plus`, `Minus`, `ChevronDown`, `Search`.
- **Sizes:** 14px in the header toggles, 16px in the console sidebar, 20px in capability cells and process markers, and 20–26px in the falling layer.
- **Stroke:** `1.75` in the UI and `1.5` in the decorative layer.
- **Colour:** inherits `currentColor`. Orange only on markers and active states.
- Decorative icons get `aria-hidden`. An icon used as the only content of a control needs an accessible label.

---

## 8. Motion

- Control changes (hover, focus, press, active toggle) use `var(--dp-motion-interaction) var(--dp-motion-easing)`.
- The lighting, the gradient and the process connectors are **static**.
- The only continuous motion is the falling-icon layer on the landing page (§5.2). The hexagon field (§5.2a) moves only in response to the cursor.
- There are no spinning tokens, animated balances or counting-up numbers.
- `@media (prefers-reduced-motion: reduce)` removes every transition and animation, including the falling icons.

---

## 9. Responsive behaviour

| Breakpoint | Changes |
| --- | --- |
| **≤ 1100px** | Tighter gaps. The hero title scales to 40–52px. The console explorer narrows to 240px. |
| **≤ 900px** | The console explorer floats over the editor with a scrim and starts closed. |
| **≤ 800px** | Paired prose stacks. The process row and capability matrix go to 2 columns. Falling icons drop to 8. |
| **≤ 700px** | The console's bottom panel is hidden and the palette becomes an icon button. |
| **≤ 640px** | The header's two toggles fold into the round menu button with a drop-down panel. |
| **≤ 520px** | The capability matrix goes to 1 column. The process row becomes a vertical sequence with the connector down the left. The footer drops to 2 columns. The falling-icon layer is hidden. |

Verify the actual states at each width: open and closed menu, active toggle and console tab, and focus rings.

---

## 10. Accessibility

- Every interactive element keeps a visible `:focus-visible` ring (orange, 2px, offset 2px).
- Keep the skip link ("Skip to content") as the first focusable element, above the floating header.
- Text contrast is 4.5:1 or better everywhere, and 7:1 or better for body text on the landing gradient.
- Reading order follows visual order: header, hero, introduction, steps, capabilities, closing. In the console: sidebar, then the page.
- Nav toggles keep `aria-current="page"`, and the menu button keeps `aria-expanded` / `aria-controls`.

---

## 11. Limits

- Warm light stays local: there are no large orange backgrounds.
- No multicolour gradients, glassy cards, 3D coins or crypto decoration.
- No invented numbers, savings claims or testimonials. The landing page shows no figures at all; live numbers appear only in the console and model pages.
- No routes changed. The header has two toggles (Models, Console); new features are added as console sidebar entries.
- The synthetic replay badge and its labelling stay clearly visible in every theme state.

---

## 12. Implementation

Built on 2026-11-05. Snapshots in `ui-snapshots/` (local only, git-ignored) restore earlier states (copy a snapshot's files back over `web/`):
- `2026-11-06-before-akash/`: just before the Akash reference layer (§5E).
- `2026-11-05-before-design/`: the UI before any of this design.
- `2026-11-05-design-v2/`: before the console became a full-screen workspace (sidebar console, GPU and model cards, hexagon hero).
- `2026-11-05-design-v1/`: the first build (navy gradient, seven header toggles, live stats and the job panel on the landing page), plus its DESIGN.md.

| File | Change |
| --- | --- |
| `web/index.html` | Geist / JetBrains Mono (was IBM Plex); orange favicon stroke |
| `web/package.json` | Adds `lucide-react` |
| `web/src/design.css` (new) | All of this design: tokens and mapping, pill header, primitives, landing page, console layout, responsive and reduced-motion rules. Loaded last from `main.tsx` |
| `web/src/main.tsx` | Imports `design.css` |
| `web/src/App.tsx` | Header toggles reduced to Models and Console; console routes render inside `Console`; the landing page renders without waiting for live data; Escape closes the small-screen menu |
| `web/src/console.tsx` (new) | The full-screen console workspace: title bar, labelled side navigation (§5F), explorer, tabs, Activity/Problems panel, status bar, command palette |
| `web/src/pages/Landing.tsx` (new) | The landing page and the falling-icon layer; the hero sits inside `HexField` |
| `web/src/hexfield.tsx` (new) | The hexagon field with the cursor-following light |
| `web/src/pages/Overview.tsx` | Now the console's Overview: live totals, recent jobs, live activity |
| `web/src/pages/Models.tsx` | Model list as grouped rows (`ModelRow`, §5F) with checkbox filters |
| `web/src/pages/Providers.tsx` | GPU table replaced by GPU cards; live GPUs sorted first |
| `web/src/zerog.tsx` | Privy sign-in accent colour set to orange |
| `web/src/site.css` (new, loaded after `design.css`) | §5E: neutral palette, Geist / JetBrains Mono, 8px controls, header bar, landing sections, Models heading, form and timestamp alignment |
| `web/src/app.css` (new, loaded last) | §5F: Models rows and checkbox filters, console side navigation, tabs and status bar, console page cards, totals, tags, links and notices |
| `web/src/sitefooter.tsx` (new) | The website footer shared by the landing page and Models; replaces the old status strip there |
| `web/public/shots/` (new) | Console screenshots for the landing showcase |

`styles.css`, `theme.css`, `pages.css` and `product.css` are untouched; `design.css` overrides them.
