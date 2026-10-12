import { Avatar, IconTile } from '@/components/Avatar';
import { Block } from '@/components/Card';
import { Row, Rows } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { me, orgName, roleLabel } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { morePages } from '@/nav/morePages';
import { href, push, tab2 } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';
import { colors } from '@/theme';

/**
 * S5-MORE (SPEC §2.5): profile row, the role's Pages, Account (Profile settings, Sign
 * out). W3 owns this screen; F0 ships a working version.
 */
export function MoreScreen() {
  const u = useAppState(me);
  const org = useAppState((s) => (u ? orgName(s, u) : ''));
  const { signOut } = useActions();
  const actions = useRootActions();
  if (!u) return null;
  const pages = morePages(u.role);
  return (
    <Screen title="More" actions={actions} testID="screen-more">
      <Rows>
        <Row lead={<Avatar name={u.name} />} title={u.name} sub={`${roleLabel(u)} · ${org}`} onPress={() => push(href.me())} testID="more-profile" />
      </Rows>
      <Block title="Pages">
        <Rows empty="Everything you can open is in the tab bar." testID="more-pages">
          {pages.map((p) => (
            <Row
              key={p.key}
              lead={<IconTile icon={p.icon} bg={colors.track} fg={colors.primaryInk} />}
              title={p.label}
              sub={p.sub}
              onPress={() => tab2(p.key, u.role)}
              testID={`more-page-${p.key}`}
            />
          ))}
        </Rows>
      </Block>
      <Block title="Account">
        <Rows>
          <Row lead={<IconTile icon="user-round-cog" />} title="Profile settings" sub="Details, notifications, password" onPress={() => push(href.me())} testID="more-profile-settings" />
          <Row
            lead={<IconTile icon="log-out" bg={colors.destructiveBg} fg={colors.destructiveInk} />}
            title="Sign out"
            titleColor={colors.destructiveInk}
            chevron={false}
            onPress={signOut}
            testID="more-sign-out"
          />
        </Rows>
      </Block>
    </Screen>
  );
}
