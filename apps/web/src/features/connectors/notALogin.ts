/**
 * A service's own sign-in (UniFi's username and password, a mail account's) is not a login to this page. Safari's
 * AutoFill ignores autocomplete="off" on what looks like a username and password, and its fill menu, like a password
 * manager's, takes the focus from the box just clicked. Password managers (1Password, LastPass, Bitwarden, Dashlane)
 * leave fields marked like this alone; a password box adds autocomplete="new-password", as an API key's has.
 */
export const NOT_A_LOGIN = {
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const;
