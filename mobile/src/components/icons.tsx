/**
 * Icon registry: lucide names from SPEC.md §5.7 → lucide-react-native components.
 * Icons are imported one by one so the bundle does not carry the whole library.
 * To add an icon: import it from 'lucide-react-native/icons/<file>' and add a key.
 */
import type { LucideIcon } from 'lucide-react-native';
import Activity from 'lucide-react-native/icons/activity';
import AlarmClock from 'lucide-react-native/icons/alarm-clock';
import Archive from 'lucide-react-native/icons/archive';
import ArrowRightLeft from 'lucide-react-native/icons/arrow-right-left';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import Bell from 'lucide-react-native/icons/bell';
import BellRing from 'lucide-react-native/icons/bell-ring';
import Bookmark from 'lucide-react-native/icons/bookmark';
import Bug from 'lucide-react-native/icons/bug';
import BugOff from 'lucide-react-native/icons/bug-off';
import Building2 from 'lucide-react-native/icons/building-complex';
import CalendarCheck from 'lucide-react-native/icons/calendar-check';
import CalendarClock from 'lucide-react-native/icons/calendar-clock';
import CalendarDays from 'lucide-react-native/icons/calendar-days';
import CalendarPlus from 'lucide-react-native/icons/calendar-plus';
import ChartGantt from 'lucide-react-native/icons/chart-gantt';
import ChartPie from 'lucide-react-native/icons/chart-pie';
import Check from 'lucide-react-native/icons/check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import ChevronsUp from 'lucide-react-native/icons/chevrons-up';
import Circle from 'lucide-react-native/icons/circle';
import CircleArrowRight from 'lucide-react-native/icons/circle-arrow-right';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import CircleDot from 'lucide-react-native/icons/circle-dot';
import Clock3 from 'lucide-react-native/icons/clock-3';
import CornerDownRight from 'lucide-react-native/icons/corner-down-right';
import Download from 'lucide-react-native/icons/download';
import Equal from 'lucide-react-native/icons/equal';
import FileChartColumn from 'lucide-react-native/icons/file-chart-column';
import FileDown from 'lucide-react-native/icons/file-down';
import FilePenLine from 'lucide-react-native/icons/file-pen-line';
import FileText from 'lucide-react-native/icons/file-text';
import Flag from 'lucide-react-native/icons/flag';
import FolderCheck from 'lucide-react-native/icons/folder-check';
import FolderKanban from 'lucide-react-native/icons/folder-kanban';
import GitBranch from 'lucide-react-native/icons/git-branch';
import GitFork from 'lucide-react-native/icons/git-fork';
import Hammer from 'lucide-react-native/icons/hammer';
import House from 'lucide-react-native/icons/house';
import Image from 'lucide-react-native/icons/image';
import Inbox from 'lucide-react-native/icons/inbox';
import LayoutGrid from 'lucide-react-native/icons/layout-grid';
import LifeBuoy from 'lucide-react-native/icons/life-buoy';
import List from 'lucide-react-native/icons/list';
import Lock from 'lucide-react-native/icons/lock';
import LogOut from 'lucide-react-native/icons/log-out';
import MessageCircleQuestion from 'lucide-react-native/icons/message-circle-question-mark';
import MessageSquareText from 'lucide-react-native/icons/message-square-text';
import Minus from 'lucide-react-native/icons/minus';
import Paperclip from 'lucide-react-native/icons/paperclip';
import Pencil from 'lucide-react-native/icons/pencil';
import PencilLine from 'lucide-react-native/icons/pencil-line';
import Plus from 'lucide-react-native/icons/plus';
import Repeat2 from 'lucide-react-native/icons/repeat-2';
import Rocket from 'lucide-react-native/icons/rocket';
import History from 'lucide-react-native/icons/rotate-ccw-clock';
import Send from 'lucide-react-native/icons/send';
import Server from 'lucide-react-native/icons/server';
import ServerCog from 'lucide-react-native/icons/server-cog';
import Settings2 from 'lucide-react-native/icons/settings-2';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import Siren from 'lucide-react-native/icons/siren';
import SquareCheckBig from 'lucide-react-native/icons/square-check-big';
import SquareKanban from 'lucide-react-native/icons/square-kanban';
import Ticket from 'lucide-react-native/icons/ticket';
import Timer from 'lucide-react-native/icons/timer';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import UserPlus from 'lucide-react-native/icons/user-plus';
import UserRound from 'lucide-react-native/icons/user-round';
import UsersRound from 'lucide-react-native/icons/users-round';
import Wrench from 'lucide-react-native/icons/wrench';
import X from 'lucide-react-native/icons/x';

export const ICONS = {
  activity: Activity,
  'alarm-clock': AlarmClock,
  archive: Archive,
  'arrow-right-circle': CircleArrowRight,
  'arrow-right-left': ArrowRightLeft,
  'arrow-up': ArrowUp,
  bell: Bell,
  'bell-ring': BellRing,
  bookmark: Bookmark,
  bug: Bug,
  'bug-off': BugOff,
  'building-2': Building2,
  'calendar-check': CalendarCheck,
  'calendar-clock': CalendarClock,
  'calendar-days': CalendarDays,
  'calendar-plus': CalendarPlus,
  'chart-gantt': ChartGantt,
  'chart-pie': ChartPie,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'chevrons-up': ChevronsUp,
  circle: Circle,
  'circle-check': CircleCheck,
  'circle-dot': CircleDot,
  'clock-3': Clock3,
  'corner-down-right': CornerDownRight,
  download: Download,
  equal: Equal,
  'file-chart-column': FileChartColumn,
  'file-down': FileDown,
  'file-pen-line': FilePenLine,
  'file-text': FileText,
  flag: Flag,
  'folder-check': FolderCheck,
  'folder-kanban': FolderKanban,
  'git-branch': GitBranch,
  'git-fork': GitFork,
  hammer: Hammer,
  history: History,
  house: House,
  image: Image,
  inbox: Inbox,
  'layout-grid': LayoutGrid,
  'life-buoy': LifeBuoy,
  list: List,
  lock: Lock,
  'log-out': LogOut,
  'message-circle-question': MessageCircleQuestion,
  'message-square-text': MessageSquareText,
  minus: Minus,
  paperclip: Paperclip,
  pencil: Pencil,
  'pencil-line': PencilLine,
  plus: Plus,
  'repeat-2': Repeat2,
  rocket: Rocket,
  send: Send,
  server: Server,
  'server-cog': ServerCog,
  'settings-2': Settings2,
  'shield-check': ShieldCheck,
  siren: Siren,
  'square-check-big': SquareCheckBig,
  'square-kanban': SquareKanban,
  ticket: Ticket,
  timer: Timer,
  'triangle-alert': TriangleAlert,
  'user-plus': UserPlus,
  'user-round': UserRound,
  'users-round': UsersRound,
  wrench: Wrench,
  x: X,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;
