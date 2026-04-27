using Aelvory.Server.Data;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Aelvory.Server.Controllers;

/// <summary>
/// Per-project access grants. Used by the upcoming web admin UI to set
/// up "User C only sees Project A" without making them an admin of the
/// whole org.
///
/// Auth: only Org owners/admins can list/grant/revoke. Restricted
/// members can't see the grant list themselves (they only know
/// implicitly which projects they have access to).
/// </summary>
[ApiController]
[Authorize]
[Route("api/projects/{projectId:guid}/members")]
public class ProjectMembersController(
    AelvoryDbContext db,
    ICurrentUserService current,
    IActivityLogger activity,
    ISyncEntityBridge syncBridge) : ControllerBase
{
    /// <summary>
    /// Wire payload for a project_members SyncEntry. Matches
    /// <c>LProjectMember</c> in the desktop's local schema. No
    /// <c>deleted_at</c> column locally, so revoke arrives as a
    /// hard <c>DELETE</c> via applyIncoming.
    /// </summary>
    private static object ProjectMemberPayload(ProjectMember pm) => new
    {
        id = pm.Id,
        projectId = pm.ProjectId,
        userId = pm.UserId,
        grantedBy = pm.GrantedBy,
        grantedAt = pm.GrantedAt,
    };
    [HttpGet]
    public async Task<ActionResult<List<ProjectMemberDto>>> List(
        Guid projectId,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var project = await db.Projects.FirstOrDefaultAsync(
            p => p.Id == projectId && p.DeletedAt == null, ct);
        if (project is null) return NotFound();

        if (!await IsAdminAsync(project.OrganizationId, userId, ct)) return Forbid();

        var grants = await db.ProjectMembers
            .Where(pm => pm.ProjectId == projectId)
            .Select(pm => new ProjectMemberDto(
                pm.Id, pm.ProjectId, pm.UserId, pm.User.Email, pm.User.DisplayName,
                pm.GrantedBy, pm.GrantedAt))
            .ToListAsync(ct);
        return grants;
    }

    [HttpPost]
    public async Task<ActionResult<ProjectMemberDto>> Grant(
        Guid projectId,
        [FromBody] GrantProjectAccessRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var project = await db.Projects.FirstOrDefaultAsync(
            p => p.Id == projectId && p.DeletedAt == null, ct);
        if (project is null) return NotFound();

        if (!await IsAdminAsync(project.OrganizationId, userId, ct)) return Forbid();

        // The grantee must already be an org member — granting per-project
        // access to a non-member doesn't make sense (they couldn't pull
        // the org's data anyway).
        var orgMember = await db.Members.FirstOrDefaultAsync(
            m => m.OrganizationId == project.OrganizationId && m.UserId == req.UserId, ct);
        if (orgMember is null) return BadRequest(new { error = "not_org_member" });

        if (await db.ProjectMembers.AnyAsync(
                pm => pm.ProjectId == projectId && pm.UserId == req.UserId, ct))
        {
            return Conflict(new { error = "already_granted" });
        }

        var grant = new ProjectMember
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            UserId = req.UserId,
            GrantedBy = userId,
            GrantedAt = DateTime.UtcNow,
        };
        db.ProjectMembers.Add(grant);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, project.OrganizationId, "ProjectMember", grant.Id,
            "granted", new { projectId, userId = req.UserId }, ct);
        await syncBridge.PublishAsync(
            orgId: project.OrganizationId, projectId: projectId,
            entityType: "project_members", entityId: grant.Id,
            payload: ProjectMemberPayload(grant), updatedAt: grant.GrantedAt,
            deletedAt: null, userId: userId,
            excludeConnectionId: null, ct: ct);

        var user = await db.Users.SingleAsync(u => u.Id == req.UserId, ct);
        return new ProjectMemberDto(
            grant.Id, projectId, user.Id, user.Email, user.DisplayName,
            userId, grant.GrantedAt);
    }

    [HttpDelete("{grantId:guid}")]
    public async Task<IActionResult> Revoke(
        Guid projectId,
        Guid grantId,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var project = await db.Projects.FirstOrDefaultAsync(
            p => p.Id == projectId && p.DeletedAt == null, ct);
        if (project is null) return NotFound();

        if (!await IsAdminAsync(project.OrganizationId, userId, ct)) return Forbid();

        var grant = await db.ProjectMembers.FirstOrDefaultAsync(
            pm => pm.Id == grantId && pm.ProjectId == projectId, ct);
        if (grant is null) return NotFound();

        var snapshot = ProjectMemberPayload(grant);
        db.ProjectMembers.Remove(grant);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, project.OrganizationId, "ProjectMember", grantId,
            "revoked", new { projectId, userId = grant.UserId }, ct);
        // Tombstone. The revoked user's desktop receives this and
        // applyIncoming hard-DELETEs the local project_members row
        // (the desktop's schema has no deleted_at column on this
        // table). The user's project access stops at the next sync
        // — the project itself stays locally stale until either a
        // wipe or a server-side project-tombstone arrives.
        var now = DateTime.UtcNow;
        await syncBridge.PublishAsync(
            orgId: project.OrganizationId, projectId: projectId,
            entityType: "project_members", entityId: grantId,
            payload: snapshot, updatedAt: now,
            deletedAt: now, userId: userId,
            excludeConnectionId: null, ct: ct);
        return NoContent();
    }

    private Task<bool> IsAdminAsync(Guid orgId, Guid userId, CancellationToken ct) =>
        db.Members.AnyAsync(m => m.OrganizationId == orgId && m.UserId == userId &&
                                  (m.Role == MemberRole.Owner || m.Role == MemberRole.Admin), ct);
}
