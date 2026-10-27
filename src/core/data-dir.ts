import os from 'os';
import path from 'path';

/**
 * Per-user directory for the audit log and the persisted session token.
 * Never derived from process.cwd(): inside the IDE extension host that is the IDE install folder.
 */
export function dataDir(): string {
  return process.env.AG_REMOTE_DATA_DIR || path.join(os.homedir(), '.ag-remote');
}
