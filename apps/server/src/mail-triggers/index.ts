export { MAIL_TRIGGER_COMMANDS, recordMailReceived, setMailCursor } from './commands';
export {
  type MirroredMailItem,
  mailHeadline,
  mailItemKey,
  mailItemScope,
  mailTriggerFactsOf,
} from './items';
export { mailPrincipal, SYSTEM_MAIL } from './principal';
export { type MailTriggerOptions, MailTriggerService } from './service';
export {
  hasMirroredMailItem,
  type ListenedMailbox,
  listenedMailConnections,
  type MailConnectionRow,
  mailConnectionRow,
  mailTriggersOf,
  mirroredMailItem,
  personMailConnections,
} from './store';
