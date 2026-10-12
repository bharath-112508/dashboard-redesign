import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { CLIENT_COMPANY } from '@/data/seed/projects';
import { me, unreadCount } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { back, href, push } from '@/nav/routes';
import { colors, motion, pressScale, useLoop } from '@/theme';

import { Avatar } from './Avatar';
import { HeaderActionButton, SoftPillButton } from './Buttons';
import { CountBadge } from './Chips';
import { BrandMark, CompanyLogo } from './CompanyLogo';
import { Icon, type IconName } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

export interface HeaderAction {
  label: string;
  onPress: () => void;
  icon?: IconName;
  testID?: string;
}

/** Brand row: staff "V · Viljetech"; client "Daco logo · Daco admin panel · Powered by Viljetech". */
function BrandEyebrow() {
  const isClient = useAppState((s) => me(s)?.role === 'client');
  return (
    <View style={styles.brand}>
      {isClient ? <CompanyLogo company={CLIENT_COMPANY} size={18} radius={5} /> : <BrandMark />}
      <Txt v="caption" w={600} color={colors.ink3} numberOfLines={1}>
        {isClient ? `${CLIENT_COMPANY} admin panel · Powered by Viljetech` : 'Viljetech'}
      </Txt>
    </View>
  );
}

/** Bell button with the unread badge; rings twice when there is something unread. */
export function BellButton() {
  const unread = useAppState(unreadCount);
  const ring = useLoop(unread > 0 ? motion.bell(1.3, 2, 0.5) : null);
  return (
    <Press
      label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      onPress={() => push(href.inbox())}
      scale={pressScale.tab}
      style={styles.iconBtn}
      testID="header-bell"
    >
      <Animated.View style={[{ transformOrigin: '50% 8%' }, ring]}>
        <Icon name="bell" size={20} color={colors.ink} />
      </Animated.View>
      <CountBadge n={unread} outline={colors.bg} style={styles.bellBadge} />
    </Press>
  );
}

/** The signed-in person's avatar; opens Profile. */
export function AvatarButton() {
  const person = useAppState(me);
  if (!person) return null;
  return (
    <Press label="Profile" onPress={() => push(href.me())} scale={pressScale.tab} style={styles.avatarBtn} testID="header-avatar">
      <Avatar name={person.name} size={40} radius={12} bg={person.client ? colors.ink : undefined} />
    </Press>
  );
}

export interface LargeHeaderProps {
  title: string;
  action?: HeaderAction;
}

/** Root-screen header: brand eyebrow, 28/800 title, optional blue action, bell, avatar. */
export function LargeHeader({ title, action }: LargeHeaderProps) {
  return (
    <View style={styles.large}>
      <View style={styles.largeText}>
        <BrandEyebrow />
        <Txt v="titleLg" accessibilityRole="header" numberOfLines={1}>
          {title}
        </Txt>
      </View>
      <View style={styles.right}>
        {action ? (
          <HeaderActionButton label={action.label} icon={action.icon ?? 'plus'} onPress={action.onPress} testID={action.testID} />
        ) : null}
        <BellButton />
        <AvatarButton />
      </View>
    </View>
  );
}

export interface SmallHeaderProps {
  title: string;
  action?: HeaderAction;
  /** override Back (default pops the stack) */
  onBack?: () => void;
}

/** Pushed-screen header: Back, centred 16/700 title, optional soft pill action. */
export function SmallHeader({ title, action, onBack }: SmallHeaderProps) {
  return (
    <View style={styles.small}>
      <Press label="Back" onPress={onBack ?? back} style={styles.back} scale={pressScale.tile} testID="header-back">
        <Icon name="chevron-left" size={22} color={colors.primaryInk} strokeWidth={2.4} />
        <Txt v="rowTitle" w={600} color={colors.primaryInk}>
          Back
        </Txt>
      </Press>
      <View style={styles.smallTitle} pointerEvents="none">
        <Txt v="titleSm" accessibilityRole="header" numberOfLines={1} align="center">
          {title}
        </Txt>
      </View>
      <View style={styles.smallRight}>
        {action ? <SoftPillButton label={action.label} icon={action.icon} onPress={action.onPress} testID={action.testID} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  large: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingTop: 6,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  largeText: { flex: 1, gap: 4 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadge: { position: 'absolute', top: -6, right: -6 },
  avatarBtn: { borderRadius: 12 },
  small: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.lineHeader,
    backgroundColor: colors.bg,
  },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingRight: 8, height: 40, zIndex: 1 },
  smallTitle: { position: 'absolute', left: 96, right: 96, alignItems: 'center' },
  smallRight: { marginLeft: 'auto', zIndex: 1 },
});
