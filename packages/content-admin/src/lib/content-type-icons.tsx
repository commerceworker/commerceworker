import {
  BookOpen,
  Box,
  Briefcase,
  Calendar,
  FileText,
  Folder,
  Image,
  LayoutTemplate,
  type LucideIcon,
  Mail,
  MapPin,
  Megaphone,
  Newspaper,
  ShoppingBag,
  Star,
  Tag,
  User,
  Users,
  Video,
} from 'lucide-react';

/**
 * The icons a content type can name (`ContentType.icon`), by their kebab-case names. The model
 * stores any kebab-case name; the admin draws the ones it knows and nothing for the rest, so a
 * name set through the API never breaks a screen.
 */
export const CONTENT_TYPE_ICONS: Readonly<Record<string, LucideIcon>> = {
  'book-open': BookOpen,
  box: Box,
  briefcase: Briefcase,
  calendar: Calendar,
  'file-text': FileText,
  folder: Folder,
  image: Image,
  'layout-template': LayoutTemplate,
  mail: Mail,
  'map-pin': MapPin,
  megaphone: Megaphone,
  newspaper: Newspaper,
  'shopping-bag': ShoppingBag,
  star: Star,
  tag: Tag,
  user: User,
  users: Users,
  video: Video,
};

/**
 * The icon a name stands for, or undefined. By own key only: the stored name is any kebab-case
 * text, and a plain lookup would find `constructor` or `toString` on the object's prototype.
 */
export function contentTypeIcon(name: string | undefined): LucideIcon | undefined {
  return name !== undefined && Object.hasOwn(CONTENT_TYPE_ICONS, name)
    ? CONTENT_TYPE_ICONS[name]
    : undefined;
}

/**
 * A content type's icon, decorative beside its name; nothing when it names none the admin knows,
 * or, with `reserve`, an empty slot of the same size so names in a list line up.
 */
export function ContentTypeIcon(props: {
  name: string | undefined;
  className?: string;
  reserve?: boolean;
}) {
  const Icon = contentTypeIcon(props.name);
  const className = props.className ?? 'size-4 shrink-0';
  if (Icon) return <Icon aria-hidden="true" className={className} />;
  return props.reserve ? <span aria-hidden="true" className={className} /> : null;
}
