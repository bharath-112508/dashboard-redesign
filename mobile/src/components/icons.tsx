/**
 * Icon registry: the v5 lucide set (SPEC §6.1 "Icons") → lucide-react-native components.
 * Icons are imported one by one so the bundle does not carry the whole library.
 * To add an icon: import it from 'lucide-react-native/icons/<file>' and add a key.
 */
import type { LucideIcon } from 'lucide-react-native';
import ActivityIcon from 'lucide-react-native/icons/activity';
import AlarmClockIcon from 'lucide-react-native/icons/alarm-clock';
import ArchiveIcon from 'lucide-react-native/icons/archive';
import ArchiveRestoreIcon from 'lucide-react-native/icons/archive-restore';
import BadgeDollarSignIcon from 'lucide-react-native/icons/badge-dollar-sign';
import BellIcon from 'lucide-react-native/icons/bell';
import BugIcon from 'lucide-react-native/icons/bug';
import Building2Icon from 'lucide-react-native/icons/building-complex';
import CalendarIcon from 'lucide-react-native/icons/calendar';
import CalendarPlusIcon from 'lucide-react-native/icons/calendar-plus';
import CheckIcon from 'lucide-react-native/icons/check';
import ChevronDownIcon from 'lucide-react-native/icons/chevron-down';
import ChevronLeftIcon from 'lucide-react-native/icons/chevron-left';
import ChevronRightIcon from 'lucide-react-native/icons/chevron-right';
import CircleCheckIcon from 'lucide-react-native/icons/circle-check';
import CircleDotIcon from 'lucide-react-native/icons/circle-dot';
import CircleMinusIcon from 'lucide-react-native/icons/circle-minus';
import Clock3Icon from 'lucide-react-native/icons/clock-3';
import DownloadIcon from 'lucide-react-native/icons/download';
import FileTextIcon from 'lucide-react-native/icons/file-text';
import FlagIcon from 'lucide-react-native/icons/flag';
import FolderIcon from 'lucide-react-native/icons/folder';
import FolderKanbanIcon from 'lucide-react-native/icons/folder-kanban';
import GitBranchIcon from 'lucide-react-native/icons/git-branch';
import GitPullRequestIcon from 'lucide-react-native/icons/git-pull-request';
import GitPullRequestArrowIcon from 'lucide-react-native/icons/git-pull-request-arrow';
import HardDriveIcon from 'lucide-react-native/icons/hard-drive';
import HouseIcon from 'lucide-react-native/icons/house';
import ImageIcon from 'lucide-react-native/icons/image';
import InfoIcon from 'lucide-react-native/icons/info';
import LayersIcon from 'lucide-react-native/icons/layers';
import LayoutGridIcon from 'lucide-react-native/icons/layout-grid';
import ListChecksIcon from 'lucide-react-native/icons/list-checks';
import LockIcon from 'lucide-react-native/icons/lock';
import LogInIcon from 'lucide-react-native/icons/log-in';
import LogOutIcon from 'lucide-react-native/icons/log-out';
import MessageCircleQuestionIcon from 'lucide-react-native/icons/message-circle-question-mark';
import MessageSquareIcon from 'lucide-react-native/icons/message-square';
import MilestoneIcon from 'lucide-react-native/icons/milestone';
import MinusIcon from 'lucide-react-native/icons/minus';
import PaperclipIcon from 'lucide-react-native/icons/paperclip';
import PenLineIcon from 'lucide-react-native/icons/pen-line';
import PencilIcon from 'lucide-react-native/icons/pencil';
import PlayIcon from 'lucide-react-native/icons/play';
import PlusIcon from 'lucide-react-native/icons/plus';
import RefreshCwIcon from 'lucide-react-native/icons/refresh-cw';
import ReplyIcon from 'lucide-react-native/icons/reply';
import RocketIcon from 'lucide-react-native/icons/rocket';
import RotateCcwIcon from 'lucide-react-native/icons/rotate-ccw';
import SearchIcon from 'lucide-react-native/icons/search';
import SendHorizontalIcon from 'lucide-react-native/icons/send-horizontal';
import ServerIcon from 'lucide-react-native/icons/server';
import SettingsIcon from 'lucide-react-native/icons/settings';
import SheetIcon from 'lucide-react-native/icons/sheet';
import ShieldCheckIcon from 'lucide-react-native/icons/shield-check';
import SignalHighIcon from 'lucide-react-native/icons/signal-high';
import TicketIcon from 'lucide-react-native/icons/ticket';
import TimerIcon from 'lucide-react-native/icons/timer';
import Trash2Icon from 'lucide-react-native/icons/trash';
import TriangleAlertIcon from 'lucide-react-native/icons/triangle-alert';
import UploadIcon from 'lucide-react-native/icons/upload';
import UserCheckIcon from 'lucide-react-native/icons/user-check';
import UserCogIcon from 'lucide-react-native/icons/user-cog';
import UserPlusIcon from 'lucide-react-native/icons/user-plus';
import UserRoundIcon from 'lucide-react-native/icons/user-round';
import UserRoundCogIcon from 'lucide-react-native/icons/user-round-cog';
import UserXIcon from 'lucide-react-native/icons/user-x';
import UsersIcon from 'lucide-react-native/icons/users';
import UsersRoundIcon from 'lucide-react-native/icons/users-round';
import XIcon from 'lucide-react-native/icons/x';

export const ICONS = {
  'activity': ActivityIcon,
  'alarm-clock': AlarmClockIcon,
  'archive': ArchiveIcon,
  'archive-restore': ArchiveRestoreIcon,
  'badge-dollar-sign': BadgeDollarSignIcon,
  'bell': BellIcon,
  'bug': BugIcon,
  'building-2': Building2Icon,
  'calendar': CalendarIcon,
  'calendar-plus': CalendarPlusIcon,
  'check': CheckIcon,
  'chevron-down': ChevronDownIcon,
  'chevron-left': ChevronLeftIcon,
  'chevron-right': ChevronRightIcon,
  'circle-check': CircleCheckIcon,
  'circle-dot': CircleDotIcon,
  'circle-minus': CircleMinusIcon,
  'clock-3': Clock3Icon,
  'download': DownloadIcon,
  'file-text': FileTextIcon,
  'flag': FlagIcon,
  'folder': FolderIcon,
  'folder-kanban': FolderKanbanIcon,
  'git-branch': GitBranchIcon,
  'git-pull-request': GitPullRequestIcon,
  'git-pull-request-arrow': GitPullRequestArrowIcon,
  'hard-drive': HardDriveIcon,
  'house': HouseIcon,
  'image': ImageIcon,
  'info': InfoIcon,
  'layers': LayersIcon,
  'layout-grid': LayoutGridIcon,
  'list-checks': ListChecksIcon,
  'lock': LockIcon,
  'log-in': LogInIcon,
  'log-out': LogOutIcon,
  'message-circle-question': MessageCircleQuestionIcon,
  'message-square': MessageSquareIcon,
  'milestone': MilestoneIcon,
  'minus': MinusIcon,
  'paperclip': PaperclipIcon,
  'pen-line': PenLineIcon,
  'pencil': PencilIcon,
  'play': PlayIcon,
  'plus': PlusIcon,
  'refresh-cw': RefreshCwIcon,
  'reply': ReplyIcon,
  'rocket': RocketIcon,
  'rotate-ccw': RotateCcwIcon,
  'search': SearchIcon,
  'send-horizontal': SendHorizontalIcon,
  'server': ServerIcon,
  'settings': SettingsIcon,
  'sheet': SheetIcon,
  'shield-check': ShieldCheckIcon,
  'signal-high': SignalHighIcon,
  'ticket': TicketIcon,
  'timer': TimerIcon,
  'trash-2': Trash2Icon,
  'triangle-alert': TriangleAlertIcon,
  'upload': UploadIcon,
  'user-check': UserCheckIcon,
  'user-cog': UserCogIcon,
  'user-plus': UserPlusIcon,
  'user-round': UserRoundIcon,
  'user-round-cog': UserRoundCogIcon,
  'user-x': UserXIcon,
  'users': UsersIcon,
  'users-round': UsersRoundIcon,
  'x': XIcon,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;
