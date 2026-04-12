import chalk, { type ChalkInstance } from 'chalk';

const NO_COLOR = process.env['NO_COLOR'] !== undefined;

function c(color: ChalkInstance): ChalkInstance {
  return NO_COLOR ? chalk : color;
}

export const colors = {
  // Brand
  primary: c(chalk.hex('#60A5FA')),        // Blue 400 — Uplnk accent
  primaryDim: c(chalk.hex('#1E40AF')),     // Blue 800 — assistant gutter bar

  // Message lanes
  user: c(chalk.white.bold),
  assistant: c(chalk.hex('#E2E8F0')),      // Slate 200 — assistant text
  system: c(chalk.hex('#94A3B8')),         // Slate 400 — system messages

  // Status
  success: c(chalk.hex('#4ADE80')),        // Green 400
  warning: c(chalk.hex('#FBBF24')),        // Amber 400
  error: c(chalk.hex('#F87171')),          // Red 400
  muted: c(chalk.hex('#475569')),          // Slate 600

  // UI chrome
  border: c(chalk.hex('#334155')),         // Slate 700
  label: c(chalk.hex('#94A3B8').bold),     // Slate 400 bold
  cursorBg: 'blue' as const,

  // Code syntax (for chalk-based highlighting)
  code: {
    keyword:   c(chalk.hex('#C084FC')),    // Purple 400
    string:    c(chalk.hex('#86EFAC')),    // Green 300
    comment:   c(chalk.hex('#475569')),    // Slate 600
    function:  c(chalk.hex('#60A5FA')),    // Blue 400
    type:      c(chalk.hex('#FCD34D')),    // Amber 300
    number:    c(chalk.hex('#FB923C')),    // Orange 400
    operator:  c(chalk.hex('#94A3B8')),    // Slate 400
    plain:     c(chalk.hex('#E2E8F0')),    // Slate 200
  },
} as const;

/** The ▐█▌ Uplnk wordmark — renders as structural column cross-section */
export const WORDMARK = colors.primary('▐') + colors.primary.bold('█') + colors.primary('▌') + ' ' + chalk.bold('UPLNK');
