using System.Text.Json;
using System.Text.Json.Serialization;
using Aelvory.Server.Data;
using Aelvory.Server.Entities;
using Aelvory.Server.Hubs;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Aelvory.Server.Services;

/// <summary>
/// Publishes an entity-table change (typically from an admin-UI
/// controller) into the sync log so every connected desktop pulls it
/// via the same realtime path as a desktop-originated push.
///
/// Without this, admin-UI changes only reach desktops via the
/// reconciliation step inside <c>sync()</c> — which doesn't fire for
/// SignalR-driven pulls and doesn't carry deletion semantics. A
/// project deleted in the web admin UI would sit on every desktop
/// forever (or worse, with the now-removed soft-delete inference,
/// surface as data loss). Routing entity changes through SyncEntries
/// makes the path uniform: one log, one broadcast, one apply on
/// every device.
/// </summary>
public interface ISyncEntityBridge
{
    /// <summary>
    /// Reflect an entity change into <c>SyncEntries</c> and notify
    /// connected clients in the org's group via
    /// <c>SyncHub.Changed</c>.
    /// </summary>
    /// <param name="payload">
    /// Anonymous object or DTO; serialized as camelCase JSON. Should
    /// match the desktop's local row shape for the corresponding
    /// table — see <c>apps/desktop/src/localdb/schema.ts</c>.
    /// </param>
    /// <param name="deletedAt">
    /// Non-null marks this as a tombstone — desktops will either
    /// soft-delete (tables with a <c>deleted_at</c> column) or hard-
    /// delete (tables without).
    /// </param>
    /// <param name="excludeConnectionId">
    /// SignalR connection id to exclude from the broadcast. Pass the
    /// caller's own connection id (via <c>X-Sync-Connection-Id</c>
    /// header) when applicable so a client doesn't bounce the
    /// notification off its own write. For admin-UI callers (which
    /// don't keep a SignalR connection), pass null.
    /// </param>
    Task PublishAsync(
        Guid orgId,
        Guid? projectId,
        string entityType,
        Guid entityId,
        object payload,
        DateTime updatedAt,
        DateTime? deletedAt,
        Guid userId,
        string? excludeConnectionId,
        CancellationToken ct);
}

public sealed class SyncEntityBridge(
    AelvoryDbContext db,
    IHubContext<SyncHub, ISyncHubClient> syncHub) : ISyncEntityBridge
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        // Match what /api/sync/{push,pull} sends so desktop applyIncoming
        // doesn't see a different shape depending on the source.
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public async Task PublishAsync(
        Guid orgId,
        Guid? projectId,
        string entityType,
        Guid entityId,
        object payload,
        DateTime updatedAt,
        DateTime? deletedAt,
        Guid userId,
        string? excludeConnectionId,
        CancellationToken ct)
    {
        var payloadBytes = JsonSerializer.SerializeToUtf8Bytes(payload, Json);

        // Per-org Seq is monotonic — get max+1 once. Race-wise this
        // method is called inside an already-active controller scope
        // that's serialized per-request; concurrent admin operations
        // on the same org would each compute their own max, but the
        // unique index on (OrganizationId, EntityType, EntityId)
        // means at most one of them wins on the upsert and the
        // others would update an existing row anyway.
        var maxSeq = await db.SyncEntries
            .Where(e => e.OrganizationId == orgId)
            .MaxAsync(e => (long?)e.Seq, ct) ?? 0L;
        var nextSeq = maxSeq + 1;

        var existing = await db.SyncEntries.FirstOrDefaultAsync(e =>
            e.OrganizationId == orgId &&
            e.EntityType == entityType &&
            e.EntityId == entityId, ct);

        if (existing is not null)
        {
            // Last-writer-wins by UpdatedAt — same rule as
            // SyncController.Push. If the server already has a newer
            // version (e.g. a desktop pushed in the milliseconds
            // since this admin call started), don't clobber it.
            if (existing.UpdatedAt > updatedAt) return;

            existing.UserId = userId;
            existing.ProjectId = projectId;
            existing.PayloadFormat = "plain";
            existing.Payload = payloadBytes;
            existing.CryptoHeader = null;
            existing.UpdatedAt = updatedAt;
            existing.DeletedAt = deletedAt;
            existing.Seq = nextSeq;
        }
        else
        {
            db.SyncEntries.Add(new SyncEntry
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                OrganizationId = orgId,
                ProjectId = projectId,
                EntityType = entityType,
                EntityId = entityId,
                PayloadFormat = "plain",
                Payload = payloadBytes,
                CryptoHeader = null,
                UpdatedAt = updatedAt,
                DeletedAt = deletedAt,
                Seq = nextSeq,
            });
        }

        await db.SaveChangesAsync(ct);

        // Broadcast — same shape as SyncController.Push so desktops
        // can't tell the difference between an admin-UI change and a
        // desktop push.
        var clients = string.IsNullOrEmpty(excludeConnectionId)
            ? syncHub.Clients.Group(SyncHub.GroupForOrg(orgId))
            : syncHub.Clients.GroupExcept(SyncHub.GroupForOrg(orgId), excludeConnectionId);
        await clients.Changed(orgId, nextSeq, excludeConnectionId);
    }
}
