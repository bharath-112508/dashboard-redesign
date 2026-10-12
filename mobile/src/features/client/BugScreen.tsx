import { useState } from 'react';

import { BottomSheet, Block, CommentThread, EmptyBlock, Hero, IconTile, PickList, Row, Rows, Screen, TextBlock, Timeline, showToast } from '@/components';
import { TICKET_STATUS, TICKET_STATUSES } from '@/data/constants';
import { fmtY } from '@/data/format';
import { bug, epicName, isClient } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { TicketStatus } from '@/data/types';
import { colors, tones } from '@/theme';

import { bugStatusLabel, bugTone } from './client';

/** SH-BUGST (V-63, staff): To do / In progress / Review / Done, sub "Client sees: …". */
function BugStatusSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const b = useAppState((s) => bug(s, id));
  const { setBugStatus } = useActions();
  if (!b) return null;
  return (
    <BottomSheet visible title="Bug status" sub={b.title} onClose={onClose} testID="sheet-bug-status">
      <PickList
        options={TICKET_STATUSES.map((k) => ({ value: k, label: TICKET_STATUS[k].label, sub: `Client sees: ${TICKET_STATUS[k].client}`, dot: tones[TICKET_STATUS[k].tone].dot }))}
        value={b.st}
        onPick={(v: TicketStatus) => {
          const r = setBugStatus(b.id, v);
          if (!r.ok) showToast(r.error);
          onClose();
        }}
        testID="bug-status-pick"
      />
    </BottomSheet>
  );
}

/** S5-BUG: hero (client status label; staff tap → SH-BUGST), description, progress, conversation (V-62). */
export function BugScreen({ id }: { id: string }) {
  const b = useAppState((s) => bug(s, id));
  const cl = useAppState(isClient);
  const area = useAppState((s) => (b?.epicId ? epicName(s, b.epicId) : ''));
  const chat = useAppState((s) => s.bugChat[id] ?? []);
  const { replyOnBug } = useActions();
  const [st, setSt] = useState(false);

  if (!b) {
    return (
      <Screen title="Bug" testID="screen-bug">
        <EmptyBlock text="Bug not found." />
      </Screen>
    );
  }
  const ix = TICKET_STATUSES.indexOf(b.st);
  return (
    <Screen title="Bug" sub={fmtY(b.when)} testID="screen-bug">
      <Hero
        lead={<IconTile icon="bug" bg={colors.redSoft} fg={colors.dangerInk} size={46} radius={13} />}
        eyebrow={`Reported by ${b.by}`}
        title={b.title}
        sub={area || undefined}
        status={{ label: bugStatusLabel(b.st), tone: bugTone(b.st) }}
        onStatus={cl ? undefined : () => setSt(true)}
        testID="bug-hero"
      />
      <Block title="What happened">
        <TextBlock text={b.desc} />
      </Block>
      {b.atts.length ? (
        <Block title="Photos & files">
          <Rows>
            {b.atts.map((f, i) => (
              <Row key={i} lead={<IconTile icon={/\.(png|jpe?g|gif|webp)$/i.test(f.n) ? 'image' : 'file-text'} />} title={f.n} sub={`${f.size} · ${fmtY(f.when)}`} />
            ))}
          </Rows>
        </Block>
      ) : null}
      <Block title="Progress" testID="bug-progress">
        <Timeline
          items={TICKET_STATUSES.map((k, i) => ({
            dot: i <= ix ? colors.green : colors.lineInput,
            ring: i === ix ? colors.greenSoft : colors.transparent,
            title: TICKET_STATUS[k].client,
            titleColor: i <= ix ? colors.ink : colors.ink3,
            sub: i === ix ? 'Current step' : undefined,
            subColor: colors.greenInk,
          }))}
        />
      </Block>
      <Block title="Conversation">
        <CommentThread
          comments={chat}
          empty="No replies yet."
          placeholder="Write a reply…"
          onSend={(t) => {
            const r = replyOnBug(b.id, t);
            if (!r.ok) showToast(r.error);
            return r.ok;
          }}
          testID="bug-chat"
        />
      </Block>
      {st ? <BugStatusSheet id={b.id} onClose={() => setSt(false)} /> : null}
    </Screen>
  );
}
