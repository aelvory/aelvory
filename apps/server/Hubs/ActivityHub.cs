using Microsoft.AspNetCore.SignalR;

namespace Aelvory.Server.Hubs;

public class ActivityHub : Hub
{
    public Task JoinOrganization(string orgId)
        => Groups.AddToGroupAsync(Context.ConnectionId, $"org:{orgId}");

    public Task LeaveOrganization(string orgId)
        => Groups.RemoveFromGroupAsync(Context.ConnectionId, $"org:{orgId}");
}
