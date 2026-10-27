// Browser default is unavailable, not an empty native account inventory.
// Tests/lab may substitute this transport leaf; it never mints native ownership.
import type { ConnectionError, ConnectionStatus, ManagedConnectionPage } from './generated/actions';

const unavailable: ConnectionError = 'unavailable';
export function managedConnections(cursor: string | null): Promise<ManagedConnectionPage> {
  void cursor;
  return Promise.reject(unavailable);
}
export function managedConnectionStatus(connectionId: string): Promise<ConnectionStatus> {
  void connectionId;
  return Promise.reject(unavailable);
}
export function managedConnectionAdd(host: string, login: string): Promise<ConnectionStatus> {
  void host;
  void login;
  return Promise.reject(unavailable);
}
export function managedConnectionDisable(
  connectionId: string,
  expectedRevision: number,
): Promise<ConnectionStatus> {
  void connectionId;
  void expectedRevision;
  return Promise.reject(unavailable);
}
