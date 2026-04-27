using System.Security.Claims;
using Aelvory.Server.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Aelvory.Server.Hubs;

/// <summary>
/// Real-time sync notifications. Each client joins one group per
/// organization they're a member of. After a successful push to an org,
/// <c>SyncController</c> calls <c>NotifyChanged</c> on this hub which
/// broadcasts a <c>changed</c> event to every other connection in that
/// org's group. Receivers run a pull to catch up.
///
/// Authentication is via the same JWT bearer scheme as the REST
/// controllers; hubs accept the token via <c>?access_token=</c> query
/// (see Program.cs). On connect, we look up the user's memberships and
/// register the connection in each corresponding org group.
///
/// Membership changes (a user gets added to a new org, or removed) take
/// effect on the user's next reconnection — we don't try to live-update
/// group membership. Acceptable trade-off: members joining mid-session
/// don't see live updates from the new org until they sign out and back
/// in or the client reconnects naturally.
/// </summary>
[Authorize]
public class SyncHub(AelvoryDbContext db) : Hub<ISyncHubClient>
{
    public static string GroupForOrg(Guid organizationId) => $"sync-org:{organizationId:N}";

    public override async Task OnConnectedAsync()
    {
        if (TryGetUserId(out var userId))
        {
            var orgIds = await db.Members
                .Where(m => m.UserId == userId)
                .Select(m => m.OrganizationId)
                .ToListAsync();
            foreach (var orgId in orgIds)
            {
                await Groups.AddToGroupAsync(Context.ConnectionId, GroupForOrg(orgId));
            }
        }
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // SignalR auto-removes the connection from all its groups on
        // disconnect, so we don't need explicit RemoveFromGroupAsync
        // calls. Override is here only to allow future hooks (logging,
        // metrics, etc.).
        await base.OnDisconnectedAsync(exception);
    }

    private bool TryGetUserId(out Guid userId)
    {
        var sub = Context.User?.FindFirst("sub")?.Value
            ?? Context.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(sub, out userId);
    }
}

/// <summary>
/// Strongly-typed client surface for <see cref="SyncHub"/>. Adding a
/// method here ensures controllers calling it via
/// <c>IHubContext&lt;SyncHub, ISyncHubClient&gt;</c> stay in sync with
/// the wire protocol.
/// </summary>
public interface ISyncHubClient
{
    /// <param name="organizationId">Org whose data changed. Receivers
    /// only act on orgs they're tracking locally.</param>
    /// <param name="serverCursor">Current max <c>Seq</c> for that org;
    /// clients can short-circuit a pull if they're already at-or-beyond
    /// this cursor.</param>
    /// <param name="excludeConnectionId">Connection that originated the
    /// push. The server already excludes this from the broadcast, but
    /// receivers can double-check.</param>
    Task Changed(Guid organizationId, long serverCursor, string? excludeConnectionId);
}
