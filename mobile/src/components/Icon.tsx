import { colors } from '@/theme';

import { ICONS, type IconName } from './icons';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/** A lucide icon by its kebab-case name. Decorative: hidden from screen readers. */
export function Icon({ name, size = 20, color = colors.ink, strokeWidth = 2 }: IconProps) {
  const C = ICONS[name];
  return (
    <C
      size={size}
      color={color}
      strokeWidth={strokeWidth}
      aria-hidden
    />
  );
}

export type { IconName };
