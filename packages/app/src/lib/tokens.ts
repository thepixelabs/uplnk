/**
 * Design tokens — single source of truth for all color and spacing constants.
 *
 * These tokens centralise every hardcoded hex, named color, and spacing integer
 * currently scattered across component files. Components should import from here
 * rather than inlining literals.
 *
 * Migration status: tokens defined here, components NOT yet migrated.
 * See design/design-system.md §8 for the migration backlog.
 *
 * Theme note: the `colors` export in lib/colors.ts exposes chalk-wrapped
 * ChalkInstance values for chalk-based rendering (syntax.ts, WORDMARK, etc.).
 * These tokens are raw string/number constants for use as Ink JSX prop values
 * (e.g. `borderColor`, `color`, `paddingX`).
 */

// ─── Hex color values ─────────────────────────────────────────────────────────

/**
 * Raw hex strings for use as Ink `color` / `borderColor` prop values.
 * Two variants per token: dark (default) and light (UPLNK_THEME=light).
 */
export const hex = {
  // Brand
  primary:        { dark: '#60A5FA', light: '#2563EB' },  // Blue 400 / Blue 600
  primaryDim:     { dark: '#1E40AF', light: '#1D4ED8' },  // Blue 800 / Blue 700

  // Message lanes
  user:           { dark: '#FFFFFF', light: '#0F172A' },  // white / Slate 900
  assistant:      { dark: '#E2E8F0', light: '#1E293B' },  // Slate 200 / Slate 800
  system:         { dark: '#94A3B8', light: '#64748B' },  // Slate 400 / Slate 500

  // Status
  success:        { dark: '#4ADE80', light: '#16A34A' },  // Green 400 / Green 600
  warning:        { dark: '#FBBF24', light: '#D97706' },  // Amber 400 / Amber 600
  error:          { dark: '#F87171', light: '#DC2626' },  // Red 400 / Red 600
  muted:          { dark: '#475569', light: '#64748B' },  // Slate 600 / Slate 500

  // UI chrome / borders
  border:         { dark: '#334155', light: '#CBD5E1' },  // Slate 700 / Slate 300
  borderSubtle:   { dark: '#1E293B', light: '#CBD5E1' },  // Slate 800 / Slate 300

  // Syntax highlighting
  syntax: {
    keyword:      { dark: '#C084FC', light: '#7C3AED' },  // Purple 400 / Violet 700
    string:       { dark: '#86EFAC', light: '#15803D' },  // Green 300 / Green 700
    comment:      { dark: '#475569', light: '#94A3B8' },  // Slate 600 / Slate 400
    function:     { dark: '#60A5FA', light: '#2563EB' },  // Blue 400 / Blue 600
    type:         { dark: '#FCD34D', light: '#B45309' },  // Amber 300 / Amber 700
    number:       { dark: '#FB923C', light: '#C2410C' },  // Orange 400 / Orange 700
    operator:     { dark: '#94A3B8', light: '#64748B' },  // Slate 400 / Slate 500
    plain:        { dark: '#E2E8F0', light: '#1E293B' },  // Slate 200 / Slate 800
  },
} as const;

// ─── Theme-resolved color tokens ─────────────────────────────────────────────

const LIGHT_THEME = process.env['UPLNK_THEME'] === 'light';

function resolve<K extends { dark: string; light: string }>(token: K): string {
  return LIGHT_THEME ? token.light : token.dark;
}

/**
 * Theme-resolved flat color tokens — always a string, ready for Ink color props.
 * These resolve at module load time based on UPLNK_THEME.
 */
export const color = {
  primary:        resolve(hex.primary),
  primaryDim:     resolve(hex.primaryDim),
  user:           resolve(hex.user),
  assistant:      resolve(hex.assistant),
  system:         resolve(hex.system),
  success:        resolve(hex.success),
  warning:        resolve(hex.warning),
  error:          resolve(hex.error),
  muted:          resolve(hex.muted),
  border:         resolve(hex.border),
  borderSubtle:   resolve(hex.borderSubtle),

  syntax: {
    keyword:      resolve(hex.syntax.keyword),
    string:       resolve(hex.syntax.string),
    comment:      resolve(hex.syntax.comment),
    function:     resolve(hex.syntax.function),
    type:         resolve(hex.syntax.type),
    number:       resolve(hex.syntax.number),
    operator:     resolve(hex.syntax.operator),
    plain:        resolve(hex.syntax.plain),
  },
} as const;

// ─── Ink named colors ─────────────────────────────────────────────────────────

/**
 * Ink named color constants.
 *
 * These bypass chalk and map directly to terminal ANSI named colors.
 * Use them when chalk ANSI escape codes would interfere with Ink's layout
 * measurement (box borders, widestLine calculations).
 *
 * Warning: named colors are NOT theme-aware — they always resolve to the
 * terminal's 16-color palette. Use hex tokens above for theme-sensitive UI.
 */
export const namedColor = {
  /** Neutral chrome borders — Header, StatusBar */
  chrome:     'gray',
  /** Active input ring, prompt symbol — ChatInput */
  inputActive: 'cyan',
  /** Error state — ErrorBanner border and title */
  errorState:  'red',
  /** Warning / approval required — ApprovalDialog */
  warnState:   'yellow',
  /** Success / allow action */
  successState: 'green',
  /** Streaming block cursor background */
  cursorBg:    'blue',
  /** Selected item in list (ModelSelectorScreen) */
  selected:    'blue',
} as const;

// ─── Spacing tokens ───────────────────────────────────────────────────────────

/**
 * Spacing scale in character cells (Ink padding/margin integers).
 * One unit = one terminal column or row.
 */
export const space = {
  none:   0,
  xs:     1,   // Tight chrome border padding (Header, StatusBar paddingX)
  sm:     2,   // Dialog inner horizontal padding (ApprovalDialog paddingX)
  md:     3,   // Reserved — not currently in use
  lg:     4,   // Reserved — major section gap
} as const;

/**
 * Semantic spacing aliases — name the intent, not just the magnitude.
 */
export const spacing = {
  /** Horizontal padding inside all chrome borders (Header, StatusBar, code blocks) */
  panelPaddingX:    space.xs,
  /** Vertical padding inside modal/dialog borders */
  dialogPaddingY:   space.xs,
  /** Horizontal padding inside modal/dialog borders */
  dialogPaddingX:   space.sm,
  /** Vertical gap between messages (marginY on each message item) */
  messageGap:       space.xs,
  /** Top gap between screen title and first list item */
  listTopGap:       space.xs,
} as const;

// ─── Border style tokens ──────────────────────────────────────────────────────

/**
 * Ink borderStyle values in use across the codebase.
 * Import these rather than inlining string literals.
 */
export const borderStyle = {
  /** Neutral chrome: Header, StatusBar, code block headers */
  chrome:   'single',
  /** Interactive input element: ChatInput */
  input:    'round',
  /** Elevated state requiring attention: ErrorBanner */
  error:    'double',
  /** Elevated state requiring user decision: ApprovalDialog */
  warning:  'double',
  /** Code block body (attached below label — uses borderTop=false) */
  codeBody: 'single',
  /** Artifact panel border */
  panel:    'single',
} as const satisfies Record<string, 'single' | 'double' | 'round' | 'bold' | 'singleDouble' | 'doubleSingle' | 'classic'>;

// ─── Status indicator tokens ──────────────────────────────────────────────────

/**
 * Stream status display configuration.
 * Color values are Ink named colors (intentional — these are chrome-level
 * indicators that don't need hex precision or theme awareness).
 */
export const streamStatus = {
  idle:       { label: '●',             color: 'gray'   },
  connecting: { label: '○ connecting…', color: 'yellow' },
  streaming:  { label: '▶ streaming',   color: 'green'  },
  done:       { label: '✓',             color: 'green'  },
  error:      { label: '✗ error',       color: 'red'    },
} as const;

// ─── Icon / symbol tokens ─────────────────────────────────────────────────────

/**
 * The prefix/icon vocabulary used across the UI.
 * These must be used consistently. Do not introduce new symbols in components.
 */
export const icon = {
  /** Active/filled status dot — idle state */
  dotFilled:    '●',
  /** Empty/pending status dot — connecting state */
  dotEmpty:     '○',
  /** Streaming in progress */
  play:         '▶',
  /** Success / confirmed / done */
  check:        '✓',
  /** Error / rejected / failed */
  cross:        '✗',
  /** Warning / caution — ApprovalDialog */
  warning:      '⚠',
  /** Assistant response left gutter */
  gutterBar:    '│',
  /** Text input cursor (inline) */
  cursor:       '│',
  /** Streaming half-block cursor */
  halfBlock:    '▌',
  /** Wordmark left block */
  blockLeft:    '▐',
  /** Wordmark full block */
  blockFull:    '█',
  /** Wordmark right block */
  blockRight:   '▌',
  /** "Expand in panel" action prefix */
  expandArrow:  '▸',
  /** Chat prompt arrow */
  prompt:       '❯',
  /** Ellipsis / truncation */
  ellipsis:     '…',
  /** Horizontal rule / separator */
  hrule:        '─',
} as const;

// ─── Layout constants ─────────────────────────────────────────────────────────

/**
 * Structural layout constants.
 */
export const layout = {
  /** Lines visible in ChatInput before scrolling (multi-line display window) */
  chatInputMaxLines:    5,
  /** Code blocks >= this many lines get promoted to artifact panel */
  artifactPromoteLines: 15,
  /** Artifact panel max rendered height in lines before scroll */
  artifactMaxHeight:    40,
  /** Artifact panel scroll step (lines per arrow keypress) */
  artifactScrollStep:   5,
  /** Minimum comfortable terminal width */
  minWidth:             80,
  /** Optimal terminal width — below this, auxiliary labels hidden */
  comfortableWidth:     100,
  /** Maximum message content width on wide terminals */
  maxMessageWidth:      120,
} as const;
