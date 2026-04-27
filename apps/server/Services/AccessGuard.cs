using Aelvory.Server.Data;
using Aelvory.Server.Entities;
using Microsoft.EntityFrameworkCore;

namespace Aelvory.Server.Services;

/// <summary>
/// Centralized read/write authorization checks for the multi-tenant
/// data model. Every sub-controller (Collections, Environments,
/// Requests, Sync, etc.) calls into this so the rules stay in one
/// place.
///
/// The model:
///   - <b>Org membership</b> (Members) is the outer gate. Without a
///     row here, the user can't see anything in the org.
///   - <b>Member.Restricted</b> narrows that to "only the projects I
///     have a ProjectMember grant for." Owners and admins are
///     implicitly unrestricted regardless of the flag.
///   - <b>Roles</b>: Phase 2 still treats every member (Owner / Admin /
///     Editor) as "can write." Phase 3+ may add a fine-grained
///     read-only sub-tier; until then, can-edit ≡ can-access.
/// </summary>
public interface IAccessGuard
{
    Task<bool> IsOrgMemberAsync(Guid orgId, Guid userId, CancellationToken ct);

    Task<bool> IsOrgAdminAsync(Guid orgId, Guid userId, CancellationToken ct);

    /// <summary>
    /// Can the user see (and write to) the given project? True if
    /// they're a member of the project's org AND either unrestricted
    /// OR have an explicit ProjectMember grant. <c>null</c> projectId
    /// means "an org-level entity, just check org membership."
    /// </summary>
    Task<bool> CanAccessProjectAsync(
        Guid orgId,
        Guid? projectId,
        Guid userId,
        CancellationToken ct);

    /// <summary>
    /// Returns the set of project ids inside <paramref name="orgId"/>
    /// that the user can access. Only meaningful when the caller knows
    /// the user is a restricted member; unrestricted callers should
    /// short-circuit and not call this. Owners/admins also short-circuit
    /// (they see everything).
    /// </summary>
    Task<HashSet<Guid>> GrantedProjectIdsAsync(
        Guid orgId,
        Guid userId,
        CancellationToken ct);
}

public sealed class AccessGuard(AelvoryDbContext db) : IAccessGuard
{
    public Task<bool> IsOrgMemberAsync(Guid orgId, Guid userId, CancellationToken ct) =>
        db.Members.AnyAsync(m => m.OrganizationId == orgId && m.UserId == userId, ct);

    public Task<bool> IsOrgAdminAsync(Guid orgId, Guid userId, CancellationToken ct) =>
        db.Members.AnyAsync(m =>
            m.OrganizationId == orgId &&
            m.UserId == userId &&
            (m.Role == MemberRole.Owner || m.Role == MemberRole.Admin), ct);

    public async Task<bool> CanAccessProjectAsync(
        Guid orgId,
        Guid? projectId,
        Guid userId,
        CancellationToken ct)
    {
        var member = await db.Members
            .Where(m => m.OrganizationId == orgId && m.UserId == userId)
            .Select(m => new { m.Role, m.Restricted })
            .FirstOrDefaultAsync(ct);
        if (member is null) return false;

        // When a projectId is supplied, validate that the project
        // actually belongs to the supplied orgId. Without this, an
        // admin of org A could call CanAccessProjectAsync(orgId=A,
        // projectId=<somethingFromOrgB>) and pass the org-membership
        // check against A even though the project lives in B.
        // Today every controller that uses this guard further
        // narrows by `OrganizationId == orgId` on the actual entity
        // load — but defensive checks here mean future endpoints
        // can rely on the guard alone.
        if (projectId is not null)
        {
            var sameOrg = await db.Projects.AnyAsync(
                p => p.Id == projectId.Value && p.OrganizationId == orgId, ct);
            if (!sameOrg) return false;
        }

        // Owners/admins see everything; unrestricted Editors too.
        if (member.Role != MemberRole.Editor || !member.Restricted) return true;

        // Org-level entity (no project scope) — restricted Editor still
        // sees the org's own metadata + their own membership row.
        if (projectId is null) return true;

        return await db.ProjectMembers.AnyAsync(
            pm => pm.ProjectId == projectId.Value && pm.UserId == userId, ct);
    }

    public async Task<HashSet<Guid>> GrantedProjectIdsAsync(
        Guid orgId,
        Guid userId,
        CancellationToken ct)
    {
        var ids = await db.ProjectMembers
            .Where(pm => pm.UserId == userId &&
                pm.Project.OrganizationId == orgId &&
                pm.Project.DeletedAt == null)
            .Select(pm => pm.ProjectId)
            .ToListAsync(ct);
        return [.. ids];
    }
}
