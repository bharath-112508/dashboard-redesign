import { Block, Button, CommentThread, EmptyBlock, FieldList, Hero, Screen, showToast } from '@/components';
import { PRIORITY_DOT } from '@/data/constants';
import { canDv, myCan, request, requestProjectName } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { TicketPrio } from '@/data/types';
import { href, push } from '@/nav/routes';

/** S5-REQ DevOps request: hero, fields, Mark as done / Reopen (canDv), comments (V-99). */
export function RequestScreen({ id }: { id: string }) {
  const r = useAppState((s) => request(s, id));
  const pname = useAppState((s) => (r ? requestProjectName(s, r) : ''));
  const ce = useAppState(canDv);
  const dvAccess = useAppState((s) => myCan(s, 'DevOps Board v6'));
  const { setRequestStatus, commentOnRequest } = useActions();
  if (!r) {
    return (
      <Screen title="Request" testID="screen-request">
        <EmptyBlock text="Request not found." />
      </Screen>
    );
  }
  const done = r.status === 'Done';
  return (
    <Screen title={r.rkey} sub={pname} testID="screen-request">
      <Hero eyebrow={`${r.rkey} · ${r.type}`} title={r.text} sub={pname} status={{ label: r.status, tone: done ? 'green' : 'amber' }} testID="request-hero" />
      <FieldList
        testID="request-fields"
        items={[
          { label: 'Priority', value: r.prio, dot: PRIORITY_DOT[r.prio as TicketPrio] },
          { label: 'Raised by', value: r.by },
          { label: 'Assigned to', value: r.to || 'Unassigned' },
          { label: 'Raised', value: r.when },
          { label: 'Project', value: pname, onPress: dvAccess ? () => push(href.dvp(r.key)) : undefined, testID: 'request-project' },
        ]}
      />
      {ce ? (
        <Button
          title={done ? 'Reopen' : 'Mark as done'}
          kind={done ? 's' : 'g'}
          icon={done ? 'rotate-ccw' : 'check'}
          onPress={() => {
            const x = setRequestStatus(r.id, done ? 'Open' : 'Done');
            showToast(x.ok ? x.toast : x.error);
          }}
          testID="request-toggle"
        />
      ) : null}
      <Block title="Comments">
        <CommentThread
          comments={r.comments}
          empty="No replies yet."
          placeholder="Reply…"
          onSend={(t) => {
            const x = commentOnRequest(r.id, t);
            if (!x.ok) showToast(x.error);
            return x.ok;
          }}
          testID="request-comments"
        />
      </Block>
    </Screen>
  );
}
