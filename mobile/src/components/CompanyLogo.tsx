import { StyleSheet, View } from 'react-native';
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

/** Company logo tile; navy with initials when there is no logo (SPEC §5.8). */
export function CompanyLogo({ company, size = 32, radius }: CompanyLogoProps) {
  const xml = LOGO_XML[company];
  const r = radius ?? Math.round(size * 0.28);
  return (
    <View
      style={[styles.box, { width: size, height: size, borderRadius: r, backgroundColor: xml ? colors.white : colors.ink }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${company} logo`}
    >
      {xml ? (
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
