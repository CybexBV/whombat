import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';

/** A real link to an app path (`/files/c/general?folder=…`) that navigates in the app; modified clicks open a tab. */
export function AppLink({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const navigateHref = useNavigateHref();
  return (
    <a
      href={href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
          return;
        event.preventDefault();
        navigateHref(href);
      }}
      {...rest}
    />
  );
}
