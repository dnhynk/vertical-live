/**
 * Consented viewer identity (BOARD D-9, TASK_SPECS §T20b).
 *
 * Gate 0 §1.3 chose option (B): a viewer who opts in with the `JOIN` command
 * after reading the notice has their display name stored and shown, `LEAVE`
 * deletes it immediately, and everyone else stays anonymous. This package owns
 * the whole path — reading `authorDetails`, writing the one consent row,
 * attributing a message in memory, and deleting on request — and nothing
 * outside it touches an author field.
 */
export {
  readAuthorIdentity,
  readGrpcAuthorIdentity,
  readRestAuthorIdentity,
  type AuthorIdentity,
} from './author-details.js'
export {
  ConsentDirectory,
  issueChannelRef,
  type ConsentDirectoryOptions,
  type ConsentObservation,
  type ConsentStorePort,
} from './directory.js'
export { CONSENT_NOTICE_VERSION } from './notice.js'
