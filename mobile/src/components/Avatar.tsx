import { Image, Platform, StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { company as companyOf, project as projectOf } from '@/data/selectors/projects';
import { avatarOf, myRole } from '@/data/selectors/session';
import { useAppState } from '@/data/store';
import { FACES } from '@/data/media/faces';
import { LOGO_XML } from '@/data/media/logos';
import { hash, ini } from '@/data/format';
import { colors, radii, tilePalette } from '@/theme';

import { Icon, type IconName } from './Icon';
import { Txt } from './Txt';

export interface AvatarProps {
  name: string;
  /** default 38 (rows); 32 comments; 22 board cards; 46 hero */
  size?: number;
  /** default round; a number for square-ish tiles (hero 13, profile 14) */
  radius?: number;
  /** white 2px ring (stacked avatars) */
  ringed?: boolean;
}

/**
 * Person avatar (SPEC §2.4): staff viewers see staff photos (uploaded or built-in
 * face); clients, and client people, show initials on the person's colour.
 */
export function Avatar({ name, size = 38, radius, ringed }: AvatarProps) {
  const a = useAppState((s) => avatarOf(s, name, myRole(s)));
  const r = radius ?? size / 2;
  const box = [
    styles.box,
    { width: size, height: size, borderRadius: r, backgroundColor: a.photo || a.face ? colors.track : a.colour },
    ringed && styles.ring,
  ];
  return (
    <View style={box} accessible accessibilityRole="image" accessibilityLabel={name}>
      {a.photo ? (
        <Image source={{ uri: a.photo }} style={{ width: size, height: size }} />
      ) : a.face ? (
        <Image source={FACES[a.face]} style={{ width: size, height: size }} />
      ) : (
        <Txt v="small" w={800} color={colors.white} style={{ fontSize: Math.max(9, Math.round(size * 0.34)) }}>
          {a.initials}
        </Txt>
      )}
    </View>
  );
}

/** Up to `max` overlapping avatars (board cards). */
export function AvatarStack({ names, size = 22, max = 3 }: { names: string[]; size?: number; max?: number }) {
  return (
    <View style={styles.stack}>
      {names.slice(0, max).map((n, i) => (
        <View key={n} style={i ? { marginLeft: -5 } : null}>
          <Avatar name={n} size={size} ringed />
        </View>
      ))}
    </View>
  );
}

export interface TileProps {
  size?: number;
  radius?: number;
}

/** Square tile with an icon (row leads, More pages): 38px, radius 10. */
export function IconTile({ icon, bg = colors.track, fg = colors.ink2, size = 38, radius = radii.tile, iconSize }: TileProps & { icon: IconName; bg?: string; fg?: string; iconSize?: number }) {
  return (
    <View style={[styles.box, { width: size, height: size, borderRadius: radius, backgroundColor: bg }]}>
      <Icon name={icon} size={iconSize ?? Math.round(size * 0.47)} color={fg} />
    </View>
  );
}

/** Square tile with text (initials, "V" brand tile, sample-account initials on ink). */
export function TextTile({ text, bg = colors.ink, fg = colors.white, size = 38, radius = radii.tile }: TileProps & { text: string; bg?: string; fg?: string }) {
  return (
    <View style={[styles.box, { width: size, height: size, borderRadius: radius, backgroundColor: bg }]}>
      <Txt v="small" w={800} color={fg} style={{ fontSize: Math.round(size * 0.36) }}>
        {text}
      </Txt>
    </View>
  );
}

/** The blue "V" brand tile (Sign in). */
export function BrandMark({ size = 46, radius = radii.heroTile }: TileProps) {
  return <TextTile text="V" bg={colors.brand} size={size} radius={radius} />;
}

/**
 * Company tile (`logo`): an uploaded logo, the media.js logo, or initials on an `LGC`
 * colour picked by a hash of the name.
 */
export function CompanyTile({ name, logo, size = 38, radius = radii.tile }: TileProps & { name: string; logo?: string }) {
  const xml = logo === undefined ? LOGO_XML[name] : undefined;
  const box = [styles.box, { width: size, height: size, borderRadius: radius }];
  if (logo) {
    return (
      <View style={box} accessible accessibilityRole="image" accessibilityLabel={`${name} logo`}>
        <Image source={{ uri: logo }} style={{ width: size, height: size }} />
      </View>
    );
  }
  if (xml) {
    return (
      <View style={box} accessible accessibilityRole="image" accessibilityLabel={`${name} logo`}>
        {Platform.OS === 'web' ? (
          <Image source={{ uri: `data:image/svg+xml;base64,${btoa(xml)}` }} style={{ width: size, height: size }} />
        ) : (
          <SvgXml xml={xml} width={size} height={size} />
        )}
      </View>
    );
  }
  return (
    <View
      style={[box, { backgroundColor: tilePalette[hash(name || '?') % tilePalette.length] }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${name} logo`}
    >
      <Txt v="small" w={800} color={colors.white} style={{ fontSize: Math.round(size * 0.34) }}>
        {ini(name)}
      </Txt>
    </View>
  );
}

/** A company tile by company id. */
export function CompanyTileById({ id, ...rest }: TileProps & { id: string }) {
  const c = useAppState((s) => companyOf(s, id));
  return <CompanyTile name={c?.name ?? '?'} logo={c?.logo} {...rest} />;
}

/**
 * Project tile (DECISIONS 3): the company tile for a client project, the internal tile
 * (`layers` on violet) for an internal project.
 */
export function ProjectTile({ id, size = 38, radius = radii.tile }: TileProps & { id: string }) {
  const p = useAppState((s) => projectOf(s, id));
  const c = useAppState((s) => (p?.kind === 'client' ? companyOf(s, p.companyId) : null));
  if (!p || p.kind === 'internal') return <IconTile icon="layers" bg={colors.violetSoft} fg={colors.violetInk} size={size} radius={radius} />;
  return <CompanyTile name={c?.name ?? p.co} logo={c?.logo} size={size} radius={radius} />;
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  ring: { borderWidth: 2, borderColor: colors.white },
  stack: { flexDirection: 'row' },
});
