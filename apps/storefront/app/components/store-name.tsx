import { useStoreName } from '~/lib/store-name';

/**
 * The merchant's name above a buyer page's heading, as text. With none set it draws nothing: a
 * buyer page never stands in the platform's name for the merchant's.
 */
export function StoreName({ className = '' }: { className?: string }) {
  const name = useStoreName();
  return name ? (
    <p className={`font-semibold text-brand tracking-title ${className}`}>{name}</p>
  ) : null;
}
