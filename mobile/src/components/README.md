# src/components: the v5 block system

React Native versions of the prototype's block renderer (`design-v5/VM5 Block.dc.html`, SPEC
§6.2) plus the shell (header, tab bar, sheet, toast). Screens are composed from these blocks;
feature code does not hand-roll cards, rows or forms and uses `@/theme` tokens only (no hex).
Import from `@/components` (barrel) or the file. Every pressable goes through `Press`, which
requires an accessible `label` (DECISIONS 8). See them all at `/dev/kitchen-sink`.

## Shell

| Component | File | Use |
|---|---|---|
| `Screen` | Screen | Safe area, `Header`, scroll with padding 4/16, blocks 18 apart, bottom 110 (tab bar) / 40. Props: `title`, `sub`, `actions` (≤3), `root` (auto: tab roots get the 26px title and no Back), `noHeader` (Sign in), `tabBar`, `scroll`, `gap`, `testID="screen-<id>"`. Renders `AccessDenied` when the route is not allowed |
| `Header`, `HeaderAction` | Header | Back 40 r12, title 26/800 root or 19/800 pushed, sub 12.5, icon buttons `{icon, label, onPress, testID}` |
| `TabBar` | TabBar | Floating bar (66h r24, bottom 22), pill 54x30, badges (Tickets unread, Questions open). Drawn once by `(app)/_layout`; hidden under URL sheets. Highlights the tab that owns the stack; on a deep-linked screen the tab that owns that screen (`deepLinkOwner` in `src/nav/tabs.ts`), not Home |
| `BottomSheet` | BottomSheet | Sheet chrome (handle, 19/800 title + sub, close 36 r11, body 2/18/34, 16 gap, max 90%, sheetUp). **URL sheet**: the whole body of `app/(app)/sheet/<name>.tsx`. **Inline**: pass `visible` + `onClose` (Modal) |
| `ConfirmSheet` | BottomSheet | SH-CONFIRM: note + Cancel + destructive OK (inline) |
| `showToast`, `toastResult`, `ToastHost` | Toast | 2.4 s toast, bottom 104, `circle-check` #7FD8C9; `toastResult(r)` shows a command's toast or error |
| `AccessDenied` | AccessDenied | "You don't have access to this page" (guarded routes) |
| `PlaceholderScreen`, `PlaceholderSheet` | Placeholder | Stand-ins the W packages replace (spec id, owner, params, `children`) |

## Blocks

| Component | File | Block (SPEC §6.2) |
|---|---|---|
| `Block` | Card | Any block with an optional section head: `<Block title sub action onAction>` |
| `SectionHead` | Card | 15/800 title, 12.5 sub, soft action chip 30h (#E7EEFB / #1F3FAF) |
| `Card` | Card | r16, ring #E4EAF0; `pad` none/sm/md/lg |
| `Hero` | Hero | r20 p16, 46px `lead`, eyebrow, title 20/800, sub, status pill (`onStatus` adds the chevron), chips 26h r8, bar 7h. Variants white / dark / teal (maintenance) / overdue / plain |
| `SearchField` | SearchField | 44h r12 with the search icon; on web no browser focus outline (design `outline: 0`), focus shows a blue border |
| `Segmented` | Segmented | Track #E7ECF2 r12, segments 36h r9, count pill; scrolls sideways. testIDs `${testID}-${value}` |
| `FilterChips` | Segmented | 34h pills, ink when selected, counts; bleeds into the gutter |
| `DayStrip` | DayStrip | 7 cells 64h r12 (selected ink, also when it is today; an unselected today has a blue border; short day hours #A5502C) |
| `KpiGrid` | KpiGrid | 2 columns, tiles r16, dot + label, 21/800 value + "of", sub; optional `onPress` |
| `Rows`, `Row` | Row | Card of rows with dividers; `Row` has every v5 slot: `check` (left box, green when done), `lead` (tile/avatar), `dot`, `monoKey`, `title` (+`strike`), `sub` (+`subWrap`), `bar` (with red overflow), `meta[]` (icon, text, bold, mini bar), `badge`, `right`, `toggle`, `picked`, `chevron`, `bg`, `opacity`. `Rows empty="…"` shows an `EmptyBlock` |
| `TicketRow`, `openTicket` | TicketRow | The ticket row (`tRow`) everywhere; `openTicket(key)` clears unread (V-20) and pushes |
| `ProgressList` | ProgressList | `PG` items: bar 7h, amber at ≥85%, blue + red overflow when over budget |
| `WeekBars` | WeekBars | Stacked billable / non-billable / idle (hatched), labels, legend, foot; `idle={false}` for freelancers. Day totals stay on one line ("26h 45m" uses a smaller size), so team charts show exact minutes |
| `StepBars` | StepBars | DevOps rows: title, status pill, 4 segments (done / current / future) |
| `HeatTable` | HeatTable | Project/task × M–S minutes, rgba(72,112,232,.18–.90), total column |
| `Timeline` | Timeline | 11px dot in a 3px ring (a transparent ring leaves 11px, as the prototype) + connector, mono key, title, right text, sub (deploys, ladders, phases, bug progress, activity) |
| `Gantt` | Gantt | 4 ticks, tracks with positioned bars, orange today line (positions from the caller) |
| `Board`, `BoardCard` | Board | Snapping 272px columns on #EDF1F6, cards r12 (dot, key, due, title, type tag, subtasks, comments, avatars) |
| `FieldList` | FieldList | Label 118w + value right (dot, colour), chevron or `icon="pencil"` when tappable; '' → "—" |
| `TextBlock` | TextBlock | Tones plain / note / info / bad / good |
| `Button`, `ButtonRow` | Buttons | 48h r14; kinds `p` blue, `s` white, `d` destructive, `g` green, `ink` |
| `CommentThread` | CommentThread | Bubbles (mine right, blue), empty text, inline composer; `onSend(text)` |
| `PickList` | PickList | Sheet rows with a right check box (status / priority / sprint pickers) |
| `EmptyBlock` | EmptyBlock | Centred 13.5 text in a card |

## Form fields (`fields/`)

`Form` (12 apart), `Field` (label + `required` "*" / `optional` "(optional)", `hint`, `error`),
`TextField` (`type` text/email/password/number, `readOnly`), `TextArea`, `SelectField`
(native `<select>` on web, option sheet on native), `DateField` (`<input type=date>` on web, ISO
text on native), `PickField` (single `value` or `multi` `values`), `ToggleField`,
`HoursMinutesField` (h + min), `FileField` (dashed tile; `image` scales to 200px on web; native
uses expo-document-picker). Errors render with `testID="field-error"`.

## Bits, avatars and tiles

| Component | File | Use |
|---|---|---|
| `Badge` | Bits | Status pill 22h r7 with dot; `tone` = tone name, Tone, or `{bg, ink, dot}` |
| `RoleBadge` | Bits | Role pill in `RL` colours |
| `Dot`, `PriorityDot`, `TypeTag`, `MonoKey`, `CountBadge` | Bits | Small pieces; `MonoKey` never shrinks (row titles truncate instead) |
| `Avatar`, `AvatarStack` | Avatar | Staff photos for staff viewers only; initials on the person colour otherwise |
| `ProjectTile` | Avatar | Company logo for a client project, `layers` on violet for internal (DECISIONS 3) |
| `CompanyTile`, `CompanyTileById` | Avatar | Uploaded logo, media logo, or initials on an `LGC` colour by name hash |
| `IconTile`, `TextTile`, `BrandMark` | Avatar | Square tiles (row leads, sample accounts, "V") |
| `Toggle` | Toggle | 44x26 switch |
| `Icon`, `ICONS`, `IconName` | Icon, icons | The v5 lucide set; add icons in `icons.tsx` |
| `Txt` | Txt | Inter text; `v` = type scale (`titleRoot`, `title`, `hero`, `kpi`, `section`, `rowTitle`, `body`, `item`, `label`, `sub`, `meta`, `small`, `eyebrow`, `tab`, `tiny`, `key`) |
| `Press` | Press | Pressable with required `label`, role, `selected`/`checked` |

## Test ids

Screens `screen-<id>`, URL sheets `sheet-<name>` (close `sheet-<name>-close`), tabs `tab-<key>`,
header `header-back` / `header-title` / `header-sub` / `header-search` / `header-profile`,
field errors `field-error`, the toast `toast`, ticket rows `ticket-row-<KEY>`, board cards
`board-card-<KEY>`, segments `seg-<value>`, chips `chip-<value>`, pick rows `pick-<value>`.
