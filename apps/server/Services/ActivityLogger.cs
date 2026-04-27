using System.Text.Json;
using Aelvory.Server.Data;
using Aelvory.Server.Entities;
using Aelvory.Server.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace Aelvory.Server.Services;

public interface IActivityLogger
{
    Task LogAsync(
        Guid actorId,
        Guid organizationId,
        string entityType,
        Guid entityId,
        string action,
        object? metadata = null,
        CancellationToken ct = default);
}

public class ActivityLogger(AelvoryDbContext db, IHubContext<ActivityHub> hub) : IActivityLogger
{
    public async Task LogAsync(
        Guid actorId,
        Guid organizationId,
        string entityType,
        Guid entityId,
        string action,
        object? metadata = null,
        CancellationToken ct = default)
    {
        var log = new ActivityLog
        {
            Id = Guid.NewGuid(),
            ActorId = actorId,
            OrganizationId = organizationId,
            EntityType = entityType,
            EntityId = entityId,
            Action = action,
            MetadataJson = metadata is null ? "{}" : JsonSerializer.Serialize(metadata),
            Timestamp = DateTime.UtcNow,
        };

        db.ActivityLogs.Add(log);
        await db.SaveChangesAsync(ct);

        await hub.Clients.Group($"org:{organizationId}")
            .SendAsync("activity", new
            {
                log.Id,
                log.ActorId,
                log.OrganizationId,
                log.EntityType,
                log.EntityId,
                log.Action,
                log.Timestamp,
                Metadata = metadata,
            }, ct);
    }
}
