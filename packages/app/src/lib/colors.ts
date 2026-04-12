import chalk, { type ChalkInstance } from 'chalk';

const NO_COLOR = process.env['NO_COLOR'] !== undefined;
const LIGHT_THEME = process.env['UPLNK_THEME'] === 'light';

function c(dark: ChalkInstance, light?: ChalkInstance): ChalkInstance {
  if (NO_COLOR) return chalk;
  return LIGHT_THEME && light !== undefined ? light : dark;
}

export const colors = {
  // Brand
  primary:    c(chalk.hex('#60A5FA'), chalk.hex('#2563EB')), // Blue 400 dark / Blue 600 light
  primaryDim: c(chalk.hex('#1E40AF'), chalk.hex('#1D4ED8')), // Blue 800 dark / Blue 700 light

  // Message lanes
  user:      c(chalk.white.bold,        chalk.hex('#0F172A').bold), // Slate 900 on light
  assistant: c(chalk.hex('#E2E8F0'),    chalk.hex('#1E293B')),      // Slate 200 dark / Slate 800 light
  system:    c(chalk.hex('#94A3B8'),    chalk.hex('#64748B')),      // Slate 400 / Slate 500

  // Status
  success: c(chalk.hex('#4ADE80'), chalk.hex('#16A34A')), // Green 400 dark / Green 600 light
  warning: c(chalk.hex('#FBBF24'), chalk.hex('#D97706')), // Amber 400 / Amber 600
  error:   c(chalk.hex('#F87171'), chalk.hex('#DC2626')), // Red 400 dark / Red 600 light
  muted:   c(chalk.hex('#475569'), chalk.hex('#64748B')), // Slate 600

  // UI chrome
  border:   c(chalk.hex('#334155'), chalk.hex('#CBD5E1')), // Slate 700 dark / Slate 300 light
  label:    c(chalk.hex('#94A3B8').bold, chalk.hex('#475569').bold),
  cursorBg: 'blue' as const,

  // Code syntax (for chalk-based highlighting)
  code: {
    keyword:  c(chalk.hex('#C084FC'), chalk.hex('#7C3AED')), // Purple 400 dark / Violet 700 light
    string:   c(chalk.hex('#86EFAC'), chalk.hex('#15803D')), // Green 300 / Green 700
    comment:  c(chalk.hex('#475569'), chalk.hex('#94A3B8')), // Slate 600 dark / Slate 400 light
    function: c(chalk.hex('#60A5FA'), chalk.hex('#2563EB')), // Blue 400 / Blue 600
    type:     c(chalk.hex('#FCD34D'), chalk.hex('#B45309')), // Amber 300 / Amber 700
    number:   c(chalk.hex('#FB923C'), chalk.hex('#C2410C')), // Orange 400 / Orange 700
    operator: c(chalk.hex('#94A3B8'), chalk.hex('#64748B')), // Slate 400 / Slate 500
    plain:    c(chalk.hex('#E2E8F0'), chalk.hex('#1E293B')), // Slate 200 / Slate 800
  },
} as const;

/** The Uplnk wordmark — renders as structural column cross-section */
export const WORDMARK = colors.primary('▐') + colors.primary.bold('█') + colors.primary('▌') + ' ' + chalk.bold('UPLNK');
