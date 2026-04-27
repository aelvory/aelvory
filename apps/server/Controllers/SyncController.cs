using Aelvory.Server.Data;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Hubs;
using Aelvory.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Aelvory.Server.Controllers;

/// <summary>
/// Multi-tenant sync. Each entry is scoped to an organization (always)
/// and optionally to a project. Push validates the user is a member of
/// the target organization; pull returns entries the user is allowed to
/// see based on their org/project membership.
///
/// Cursor space is per-organization (<c>SyncEntries.Seq</c> per org),
/// so each device tracks N cursors when synced into N orgs. The
/// (orgId, since) query reflects this.
/// </summary>
[ApiController]
[Authorize]
[Route("api/sync")]
public class SyncController(
    AelvoryDbContext db,
    ICurrentUserService current,
    IAccessGuard guard,
    IHubContext<SyncHub, ISyncHubClient> syncHub) : ControllerBase
{
    // Hard cap to keep a single push from starving other users on the box.
    private const int MaxEntriesPerPush = 1000;

    [HttpPost("push")]
    public async Task<ActionResult<SyncPushResponse>> Push(
        [FromBody] SyncPushRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        if (req.Entries.Count > MaxEntriesPerPush)
            return BadRequest(new { error = "batch_too_large", max = MaxEntriesPerPush });
        if (req.Entries.Count == 0)
            return new SyncPushResponse(0, 0, 0, []);

        // Every entry in a single push must belong to the same
        // organization. The client always batches per-org, and mixing
        // orgs would make the auth check ambiguous + complicate the
        // realtime broadcast at the end.
        var orgIds = req.Entries.Select(e => e.OrganizationId).Distinct().ToList();
        if (orgIds.Count != 1)
            return BadRequest(new { error = "mixed_organizations" });
        var orgId = orgIds[0];

        // Phase 2 auth: org membership AND (for restricted Editors)
        // every entry's ProjectId must be in their grant list. Org-
        // level entries (ProjectId == null) are allowed for any
        // member.
        var memberInfo = await db.Members
            .Where(m => m.OrganizationId == orgId && m.UserId == userId)
            .Select(m => new { m.Role, m.Restricted })
            .FirstOrDefaultAsync(ct);
        if (memberInfo is null) return Forbid();

        var isRestrictedEditor =
            memberInfo.Role == MemberRole.Editor && memberInfo.Restricted;
        HashSet<Guid>? grantedProjectIds = null;
        if (isRestrictedEditor)
        {
            grantedProjectIds = await guard.GrantedProjectIdsAsync(orgId, userId, ct);
            // Reject the whole batch if any entry targets a project the
            // user can't write to. We don't accept partial pushes — the
            // client should never construct one anyway, and a hard
            // reject is easier to debug than silent partial acceptance.
            foreach (var entry in req.Entries)
            {
                if (entry.ProjectId is not null &&
                    !grantedProjectIds.Contains(entry.ProjectId.Value))
                {
                    return Forbid();
                }
            }
        }

        // Pre-load existing rows for this org's entries so we can decide
        // accept/reject in one pass.
        var entityIds = req.Entries.Select(e => e.EntityId).ToList();
        var existing = await db.SyncEntries
            .Where(e => e.OrganizationId == orgId && entityIds.Contains(e.EntityId))
            .ToDictionaryAsync(e => (e.EntityType, e.EntityId), ct);

        var accepted = 0;
        var rejected = 0;
        var conflicts = new List<SyncConflictDto>();
        var nextSeq = await NextSeqAsync(orgId, ct);

        foreach (var entry in req.Entries)
        {
            if (existing.TryGetValue((entry.EntityType, entry.EntityId), out var srv))
            {
                // Last-writer-wins by UpdatedAt. If the server's row is
                // strictly newer, we reject and report a conflict so the
                // client can re-pull the canonical version.
                if (srv.UpdatedAt > entry.UpdatedAt)
                {
                    rejected++;
                    conflicts.Add(new SyncConflictDto(
                        srv.EntityType, srv.EntityId, srv.Seq, srv.UpdatedAt));
                    continue;
                }

                srv.UserId = userId;          // record who wrote the latest version
                srv.ProjectId = entry.ProjectId;
                srv.PayloadFormat = entry.PayloadFormat;
                srv.Payload = entry.Payload ?? [];
                srv.CryptoHeader = entry.CryptoHeader;
                srv.UpdatedAt = entry.UpdatedAt;
                srv.DeletedAt = entry.DeletedAt;
                srv.Seq = nextSeq++;
                accepted++;
            }
            else
            {
                db.SyncEntries.Add(new SyncEntry
                {
                    Id = Guid.NewGuid(),
                    UserId = userId,
                    OrganizationId = orgId,
                    ProjectId = entry.ProjectId,
                    EntityType = entry.EntityType,
                    EntityId = entry.EntityId,
                    PayloadFormat = entry.PayloadFormat,
                    Payload = entry.Payload ?? [],
                    CryptoHeader = entry.CryptoHeader,
                    UpdatedAt = entry.UpdatedAt,
                    DeletedAt = entry.DeletedAt,
                    Seq = nextSeq++,
                });
                accepted++;
            }
        }

        await db.SaveChangesAsync(ct);

        var cursor = await db.SyncEntries
            .Where(e => e.OrganizationId == orgId)
            .MaxAsync(e => (long?)e.Seq, ct) ?? 0L;

        if (accepted > 0)
        {
            // Notify the org's other connected clients that there's
            // something new to pull. Excluded: the connection that just
            // pushed (if it identified itself via the sync header).
            var connectionId = Request.Headers["X-Sync-Connection-Id"].ToString();
            var clients = string.IsNullOrEmpty(connectionId)
                ? syncHub.Clients.Group(SyncHub.GroupForOrg(orgId))
                : syncHub.Clients.GroupExcept(SyncHub.GroupForOrg(orgId), connectionId);
            await clients.Changed(orgId, cursor, connectionId);
        }

        return new SyncPushResponse(accepted, rejected, cursor, conflicts);
    }

    [HttpGet("pull")]
    public async Task<ActionResult<SyncPullResponse>> Pull(
        [FromQuery] Guid orgId,
        [FromQuery] long since,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();

        var memberInfo = await db.Members
            .Where(m => m.OrganizationId == orgId && m.UserId == userId)
            .Select(m => new { m.Role, m.Restricted })
            .FirstOrDefaultAsync(ct);
        if (memberInfo is null) return Forbid();

        var isRestrictedEditor =
            memberInfo.Role == MemberRole.Editor && memberInfo.Restricted;

        // Build the LINQ query. Restricted Editors only see org-level
        // entries (ProjectId == null) plus rows for projects they have
        // explicit grants on. Owners/admins/unrestricted Editors see
        // everything in the org.
        var q = db.SyncEntries
            .Where(e => e.OrganizationId == orgId && e.Seq > since);

        if (isRestrictedEditor)
        {
            q = q.Where(e =>
                e.ProjectId == null ||
                db.ProjectMembers.Any(pm =>
                    pm.UserId == userId && pm.ProjectId == e.ProjectId));
        }

        var entries = await q
            .OrderBy(e => e.Seq)
            .Take(5000)
            .Select(e => new SyncEntryDto(
                e.OrganizationId,
                e.ProjectId,
                e.EntityType,
                e.EntityId,
                e.PayloadFormat,
                e.Payload,
                e.CryptoHeader,
                e.UpdatedAt,
                e.DeletedAt,
                e.Seq))
            .ToListAsync(ct);

        // Cursor advances to the last entry returned, or — for an empty
        // page — to the org's max Seq so a restricted user whose
        // accessible projects had no changes still moves the cursor
        // forward and doesn't keep re-pulling the same gap.
        var cursor = entries.Count > 0
            ? entries[^1].Seq
            : await db.SyncEntries
                .Where(e => e.OrganizationId == orgId)
                .MaxAsync(e => (long?)e.Seq, ct) ?? 0L;

        return new SyncPullResponse(entries, cursor);
    }

    /// <summary>
    /// Next monotonically-increasing Seq for a given organization. We
    /// use the per-org max instead of a global counter so different
    /// orgs' cursors stay numerically tight (clients only see one
    /// org's seqs, no large gaps).
    /// </summary>
    private async Task<long> NextSeqAsync(Guid orgId, CancellationToken ct)
    {
        var max = await db.SyncEntries
            .Where(e => e.OrganizationId == orgId)
            .MaxAsync(e => (long?)e.Seq, ct) ?? 0L;
        return max + 1;
    }
}
