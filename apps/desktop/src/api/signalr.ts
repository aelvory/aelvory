import {
  HubConnection,
  HubConnectionBuilder,
  LogLevel,
} from '@microsoft/signalr';
import { useAuthStore } from '@/stores/auth';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

let connection: HubConnection | null = null;

export async function connectActivityHub(): Promise<HubConnection> {
  if (connection) return connection;

  connection = new HubConnectionBuilder()
    .withUrl(`${BASE_URL}/hubs/activity`, {
      accessTokenFactory: () => useAuthStore().accessToken ?? '',
    })
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Information)
    .build();

  await connection.start();
  return connection;
}

export async function joinOrganization(orgId: string) {
  const c = await connectActivityHub();
  await c.invoke('JoinOrganization', orgId);
}

export async function leaveOrganization(orgId: string) {
  if (!connection) return;
  await connection.invoke('LeaveOrganization', orgId);
}

export function onActivity(handler: (evt: unknown) => void) {
  connectActivityHub().then((c) => c.on('activity', handler));
}
