import { Image, Platform, StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { ini } from '@/data/format';
import { LOGO_XML } from '@/data/media/logos';
import { colors } from '@/theme';

import { Txt } from './Txt';

export interface CompanyLogoProps {
  company: string;
  /** square size, default 32 */
  size?: number;
  radius?: number;
}

/**
 * Company logo tile; navy with initials when there is no logo (SPEC §5.8). The tile has
 * no background of its own (a white tile bled through as thin white corners at the
 * rounded edge). On web the logo is drawn as one image, so the rounded clip is applied
 * once, as with the prototype's background image (an inline SVG is clipped shape by
 * shape and leaves a hairline fringe at the corners).
 */
export function CompanyLogo({ company, size = 32, radius }: CompanyLogoProps) {
  const r = radius ?? Math.round(size * 0.28);
  const xml = LOGO_XML[company];
  return (
    <View
      style={[styles.box, { width: size, height: size, borderRadius: r, backgroundColor: xml ? 'transparent' : colors.ink }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${company} logo`}
    >
      {xml && Platform.OS === 'web' ? (
        <Image source={{ uri: `data:image/svg+xml;base64,${btoa(xml)}` }} style={{ width: size, height: size }} />
      ) : xml ? (
        <SvgXml xml={xml} width={size} height={size} />
      ) : (
        <Txt v="small" w={800} color={colors.white} style={{ fontSize: Math.round(size * 0.36) }}>
          {ini(company)}
        </Txt>
      )}
    </View>
  );
}

/** The 18–40px blue "V" brand tile (staff header, sign in). */
export function BrandMark({ size = 18, radius = 5 }: { size?: number; radius?: number }) {
  return (
    <View
      style={[styles.box, { width: size, height: size, borderRadius: radius, backgroundColor: colors.brand }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Viljetech"
    >
      <Txt v="small" w={800} color={colors.white} style={{ fontSize: Math.round(size * 0.55) }}>
        V
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
