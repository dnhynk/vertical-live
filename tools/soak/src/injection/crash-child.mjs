/**
 * Host-crash helper for the fault matrix row F-10 (spec §11 상태 복구).
 *
 * It opens the **already migrated** database the parent hands it, starts a
 * destructive transaction, reports `ready` on stdout and then idles until the
 * parent SIGKILLs it. That is the closest reproduction of a host crash a test can
 * make: no `finally`, no `process.on('exit')`, no clean SQLite shutdown, and an
 * open write transaction at the moment the process dies.
 *
 * It deliberately writes no schema of its own — `DELETE FROM ingest_inbox` needs
 * no column knowledge, so nothing here can drift from the migrations. What the
 * parent asserts afterwards is done through the real store and the real engine:
 * the delete must not have happened, and the restarted engine must drain every
 * row that was committed before the kill.
 *
 * Usage: node crash-child.mjs <dbFile> <busyTimeoutMs> <mode>
 */
import process from 'node:process'

import Database from 'better-sqlite3'

const [file, busyTimeoutMs, mode] = process.argv.slice(2)
if (file === undefined || busyTimeoutMs === undefined || mode === undefined) {
  process.stderr.write('usage: crash-child.mjs <dbFile> <busyTimeoutMs> <mode>\n')
  process.exit(2)
}

const database = new Database(file)
database.pragma(`busy_timeout = ${busyTimeoutMs}`)
database.pragma('journal_mode = WAL')
database.pragma('synchronous = FULL')

switch (mode) {
  // A write transaction that is open when the host dies. Nothing in it may
  // survive, and the file must still be usable by the process that restarts.
  case 'uncommitted-delete-then-kill': {
    database.exec('BEGIN IMMEDIATE')
    database.exec('DELETE FROM ingest_inbox')
    database.exec('DELETE FROM world_snapshot')
    break
  }

  default:
    process.stderr.write(`unknown mode ${mode}\n`)
    process.exit(2)
}

process.stdout.write('ready\n')
setInterval(() => {
  /* keep the event loop alive until SIGKILL arrives */
}, 1000)
