# src/components: shared UI

Import from `@/components` (barrel) or the file. Styling uses `@/theme` tokens only. Every
pressable goes through `Press`, which requires an accessible `label`. Looping animations
use `useLoop()` so they stop when the system asks for reduced motion. See them all at
`/dev/kitchen-sink`.

| Component | File | Use |
|---|---|---|
| `Txt` | Txt | Text in the app font; `v` = type scale (`titleLg`, `kpi`, `cardTitle`, `caption`, …), `color`, `w` |
| `Icon`, `ICONS`, `IconName` | Icon, icons | lucide icon by kebab-case name (SPEC §5.7); add new icons in `icons.tsx` |
| `Press` | Press | Pressable with required `label`, `a11yRole`, `selected`/`checked`, press scale |
| `Screen` | Screen | Screen scaffold: safe area, `LargeHeader`/`SmallHeader`, scroll content with room for the tab bar, fade-up enter, `footer` (composer), `noTabBar` |
| `LargeHeader`, `SmallHeader`, `BellButton`, `AvatarButton` | Headers | Root header (brand, title, blue action, bell, avatar) and pushed header (Back, title, soft action) |
| `TabBar` | TabBar | Floating role tab bar; drawn once by `(app)/_layout` |
| `BottomSheet` | BottomSheet | Sheet chrome: backdrop, handle, icon + title + subtitle, close X, scroll body, sticky `footer` |
| `showToast`, `useToast`, `ToastHost` | Toast | Dark toast for 2.2 s after a mutation |
| `Card` | Card | White card, radius 20, ring; `onPress` + `label` make it pressable (.98) |
| `ListCard`, `ListRow` | Card | Card of rows with dividers: icon tile / leading, title, sub, chevron / trailing |
| `Section`, `Eyebrow` | Card | Section title + count + link; uppercase eyebrow |
| `EmptyState`, `EmptyText` | EmptyState | Bobbing icon + line in a card; inline empty text |
| `IconTile` | IconTile | Rounded icon square on a soft colour, optional looping `anim` |
| `Chip`, `KeyChip`, `StatusPill`, `CriticalBadge`, `CountBadge`, `Dot` | Chips | Small chips, ticket key, status pill (tone from constants), red Critical badge (blinking), red count badge |
| `TypeIcon`, `PriorityGlyph` | TicketBits | Bug/Task/Story tile; priority glyph + label (Critical → badge, or High for clients) |
| `Avatar`, `AvatarStack` | Avatar | Photo or initials; clients see initials only |
| `CompanyLogo`, `BrandMark` | CompanyLogo | Company logo (navy initials fallback); blue "V" |
| `KpiTile` | DataDisplay | Home KPI tile with icon square and stagger |
| `ProgressBar`, `StackedBar`, `ProgressRing` | DataDisplay | Bars (billable/non/idle, vertical or horizontal) and ring |
| `FactTile` | DataDisplay | Ticket fact tile (label, lock, value, sub, "+" action) |
| `SegmentedControl` | Controls | `square` (Tickets filter), `pill` (Projects filter), `icon` (project views); `dot` per segment |
| `ChipRow` | Controls | Dark-selected choice chips; scrolls or `wrap`s |
| `Toggle` | Controls | Switch (md/sm, `onColor`, `readOnly`) |
| `Stepper` | Controls | −/+ with value (`compact` for settings rows) |
| `PrimaryButton`, `DarkButton`, `SecondaryButton`, `DestructiveButton`, `ApproveButton`, `SoftPillButton`, `HeaderActionButton` | Buttons | CTA styles from SPEC §5.3 |
| `Field`, `FieldError`, `TextField`, `TextArea`, `SelectField`, `DateField` | fields/ | Labelled fields; Select and Date use native `<select>`/`<input type=date>` on web and a sheet / ISO text field on native |
| `TicketCard` | TicketCard | Ticket card, `full` or `compact`; opens the ticket by default |
| `ChatBubble`, `Composer` | Chat | Chat bubbles (mine / client / staff); fixed composer with attach + send |
| `Placeholder`, `PlaceholderSheet` | Placeholder | Stand-ins for routes P1–P4 replace |

Test ids: screens use `screen-<name>`, sheets `sheet-<name>`, tabs `tab-<key>`; the header
bell is `header-bell`, the avatar `header-avatar`, Back `header-back`; form errors
`form-error`; the toast `toast`.
