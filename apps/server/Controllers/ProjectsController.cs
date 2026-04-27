using Aelvory.Server.Data;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Aelvory.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/organizations/{orgId:guid}/projects")]
public class ProjectsController(
    AelvoryDbContext db,
    ICurrentUserService current,
    IActivityLogger activity,
    IAccessGuard guard,
    ISyncEntityBridge syncBridge) : ControllerBase
{
    /// <summary>
    /// Build the wire payload for a project's SyncEntry. Field names
    /// match <c>LProject</c> in the desktop's
    /// <c>localdb/schema.ts</c> so applyIncoming can deserialize and
    /// upsert directly into the local <c>projects</c> table.
    /// </summary>
    private static object ProjectPayload(Project p) => new
    {
        id = p.Id,
        organizationId = p.OrganizationId,
        name = p.Name,
        description = p.Description,
        version = p.Version,
        createdAt = p.CreatedAt,
        updatedAt = p.UpdatedAt,
        deletedAt = p.DeletedAt,
    };
    [HttpGet]
    public async Task<ActionResult<List<ProjectDto>>> List(Guid orgId, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var memberInfo = await db.Members
            .Where(m => m.OrganizationId == orgId && m.UserId == userId)
            .Select(m => new { m.Role, m.Restricted })
            .FirstOrDefaultAsync(ct);
        if (memberInfo is null) return Forbid();

        var q = db.Projects.Where(p => p.OrganizationId == orgId && p.DeletedAt == null);

        // Restricted Editors only see projects they have explicit
        // grants for. Owners/admins/unrestricted Editors see all.
        if (memberInfo.Role == MemberRole.Editor && memberInfo.Restricted)
        {
            q = q.Where(p =>
                db.ProjectMembers.Any(pm => pm.UserId == userId && pm.ProjectId == p.Id));
        }

        var projects = await q
            .OrderBy(p => p.Name)
            .Select(p => ToDto(p))
            .ToListAsync(ct);
        return projects;
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<ProjectDto>> Get(Guid orgId, Guid id, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        if (!await guard.CanAccessProjectAsync(orgId, id, userId, ct)) return Forbid();

        var project = await db.Projects.FirstOrDefaultAsync(
            p => p.Id == id && p.OrganizationId == orgId && p.DeletedAt == null, ct);
        return project is null ? NotFound() : ToDto(project);
    }

    /// <summary>
    /// Per-project content counts for the admin UI's project list.
    /// Returned as a separate endpoint (rather than baked into
    /// <see cref="List"/>) so:
    ///   1. The cheap "what projects exist" call stays cheap — the
    ///      desktop hits <c>List</c> on every sign-in reconciliation
    ///      and doesn't need the counts.
    ///   2. The admin UI can refresh stats independently when the user
    ///      clicks "Refresh" without re-fetching the project metadata.
    ///
    /// Restricted-editor scoping mirrors <see cref="List"/>: returns
    /// stats only for projects the caller has explicit grants on.
    /// Counts are computed against <c>SyncEntries</c> because the
    /// per-entity tables (<c>Collections</c>, <c>Requests</c>, ...)
    /// aren't populated — actual content is pushed by clients as
    /// opaque sync payloads.
    /// </summary>
    [HttpGet("stats")]
    public async Task<ActionResult<List<ProjectStatsDto>>> Stats(
        Guid orgId,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var memberInfo = await db.Members
            .Where(m => m.OrganizationId == orgId && m.UserId == userId)
            .Select(m => new { m.Role, m.Restricted })
            .FirstOrDefaultAsync(ct);
        if (memberInfo is null) return Forbid();

        // Same access filter as List(): unrestricted users see every
        // non-deleted project; restricted Editors see only their grants.
        var projectIdsQ = db.Projects
            .Where(p => p.OrganizationId == orgId && p.DeletedAt == null)
            .Select(p => p.Id);
        if (memberInfo.Role == MemberRole.Editor && memberInfo.Restricted)
        {
            projectIdsQ = projectIdsQ.Where(pid =>
                db.ProjectMembers.Any(pm => pm.UserId == userId && pm.ProjectId == pid));
        }
        var projectIds = await projectIdsQ.ToListAsync(ct);

        // One scan over SyncEntries, grouped by (ProjectId, EntityType).
        // Filtering by ProjectId early uses the index on SyncEntry.ProjectId.
        // DeletedAt IS NULL excludes tombstoned rows so a project that
        // had everything deleted reports zero rather than its tombstone
        // count.
        var grouped = await db.SyncEntries
            .Where(e =>
                e.OrganizationId == orgId &&
                e.ProjectId != null &&
                e.DeletedAt == null &&
                projectIds.Contains(e.ProjectId!.Value))
            .GroupBy(e => new { ProjectId = e.ProjectId!.Value, e.EntityType })
            .Select(g => new { g.Key.ProjectId, g.Key.EntityType, Count = g.Count() })
            .ToListAsync(ct);

        // Pivot the (ProjectId, EntityType) -> Count rows into the
        // per-project DTO. Projects with zero content still get a row
        // (all zero counts) so the UI can render every visible project
        // consistently.
        var byProject = grouped
            .GroupBy(g => g.ProjectId)
            .ToDictionary(g => g.Key, g => g.ToDictionary(x => x.EntityType, x => x.Count));

        return projectIds.Select(pid =>
        {
            var counts = byProject.GetValueOrDefault(pid)
                ?? new Dictionary<string, int>();
            return new ProjectStatsDto(
                ProjectId: pid,
                CollectionCount: counts.GetValueOrDefault("collections"),
                RequestCount: counts.GetValueOrDefault("requests"),
                EnvironmentCount: counts.GetValueOrDefault("environments"),
                VariableCount: counts.GetValueOrDefault("variables"));
        }).ToList();
    }

    [HttpPost]
    public async Task<ActionResult<ProjectDto>> Create(
        Guid orgId,
        [FromBody] CreateProjectRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        if (!await IsEditorAsync(orgId, userId, ct)) return Forbid();

        var now = DateTime.UtcNow;
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OrganizationId = orgId,
            Name = req.Name,
            Description = req.Description,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Projects.Add(project);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, orgId, "Project", project.Id, "created",
            new { name = project.Name }, ct);
        await syncBridge.PublishAsync(
            orgId: orgId,
            projectId: project.Id,
            entityType: "projects",
            entityId: project.Id,
            payload: ProjectPayload(project),
            updatedAt: project.UpdatedAt,
            deletedAt: null,
            userId: userId,
            excludeConnectionId: null,
            ct: ct);
        return CreatedAtAction(nameof(Get), new { orgId, id = project.Id }, ToDto(project));
    }

    [HttpPut("{id:guid}")]
    public async Task<ActionResult<ProjectDto>> Update(
        Guid orgId,
        Guid id,
        [FromBody] UpdateProjectRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        if (!await guard.CanAccessProjectAsync(orgId, id, userId, ct)) return Forbid();

        var project = await db.Projects.FirstOrDefaultAsync(
            p => p.Id == id && p.OrganizationId == orgId && p.DeletedAt == null, ct);
        if (project is null) return NotFound();

        project.Name = req.Name;
        project.Description = req.Description;
        project.Version++;
        project.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, orgId, "Project", project.Id, "updated", null, ct);
        await syncBridge.PublishAsync(
            orgId: orgId,
            projectId: project.Id,
            entityType: "projects",
            entityId: project.Id,
            payload: ProjectPayload(project),
            updatedAt: project.UpdatedAt,
            deletedAt: null,
            userId: userId,
            excludeConnectionId: null,
            ct: ct);
        return ToDto(project);
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid orgId, Guid id, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        // Project deletion is destructive for every member with access,
        // so we restrict it to org Owners/Admins regardless of project
        // grants. Restricted Editors with grant on a project still
        // can't drop it.
        if (!await guard.IsOrgAdminAsync(orgId, userId, ct)) return Forbid();

        var project = await db.Projects.FirstOrDefaultAsync(
            p => p.Id == id && p.OrganizationId == orgId && p.DeletedAt == null, ct);
        if (project is null) return NotFound();

        project.DeletedAt = DateTime.UtcNow;
        project.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, orgId, "Project", project.Id, "deleted", null, ct);
        // Tombstone broadcast — desktops with this project locally
        // (either upserted via reconciliation or pulled via earlier
        // sync) get the deleted_at update via /api/sync/pull and hide
        // it. Without this, removed projects ghost-haunt every
        // desktop indefinitely.
        await syncBridge.PublishAsync(
            orgId: orgId,
            projectId: project.Id,
            entityType: "projects",
            entityId: project.Id,
            payload: ProjectPayload(project),
            updatedAt: project.UpdatedAt,
            deletedAt: project.DeletedAt,
            userId: userId,
            excludeConnectionId: null,
            ct: ct);
        return NoContent();
    }

    private Task<bool> IsMemberAsync(Guid orgId, Guid userId, CancellationToken ct) =>
        db.Members.AnyAsync(m => m.OrganizationId == orgId && m.UserId == userId, ct);

    /// <summary>
    /// "Can write" check at the org level. Phase 1: every member can
    /// write (Viewer role was dropped). Phase 2 will add a per-project
    /// restriction layer for restricted Editors.
    /// </summary>
    private Task<bool> IsEditorAsync(Guid orgId, Guid userId, CancellationToken ct) =>
        db.Members.AnyAsync(m => m.OrganizationId == orgId && m.UserId == userId, ct);

    private static ProjectDto ToDto(Project p) =>
        new(p.Id, p.OrganizationId, p.Name, p.Description, p.Version, p.CreatedAt, p.UpdatedAt);
}
