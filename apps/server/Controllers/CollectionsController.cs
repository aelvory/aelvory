using System.Text.Json;
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
[Route("api/projects/{projectId:guid}/collections")]
public class CollectionsController(
    AelvoryDbContext db,
    ICurrentUserService current,
    IActivityLogger activity,
    IAccessGuard guard) : ControllerBase
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    [HttpGet]
    public async Task<ActionResult<List<CollectionDto>>> List(Guid projectId, CancellationToken ct)
    {
        if (!await HasAccessAsync(projectId, ct)) return Forbid();

        var collections = await db.Collections
            .Where(c => c.ProjectId == projectId && c.DeletedAt == null)
            .OrderBy(c => c.SortIndex)
            .ToListAsync(ct);
        return collections.Select(ToDto).ToList();
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<CollectionDto>> Get(Guid projectId, Guid id, CancellationToken ct)
    {
        if (!await HasAccessAsync(projectId, ct)) return Forbid();

        var c = await db.Collections.FirstOrDefaultAsync(
            x => x.Id == id && x.ProjectId == projectId && x.DeletedAt == null, ct);
        return c is null ? NotFound() : ToDto(c);
    }

    [HttpPost]
    public async Task<ActionResult<CollectionDto>> Create(
        Guid projectId,
        [FromBody] CreateCollectionRequest req,
        CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var now = DateTime.UtcNow;
        var sortIndex = req.SortIndex ?? await db.Collections
            .Where(c => c.ProjectId == projectId && c.ParentId == req.ParentId)
            .CountAsync(ct);

        var collection = new Collection
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            ParentId = req.ParentId,
            Name = req.Name,
            SortIndex = sortIndex,
            AuthJson = req.Auth is null ? null : JsonSerializer.Serialize(req.Auth, JsonOpts),
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Collections.Add(collection);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(current.RequireUserId(), orgId.Value, "Collection",
            collection.Id, "created", new { name = collection.Name }, ct);
        return CreatedAtAction(nameof(Get), new { projectId, id = collection.Id }, ToDto(collection));
    }

    [HttpPut("{id:guid}")]
    public async Task<ActionResult<CollectionDto>> Update(
        Guid projectId,
        Guid id,
        [FromBody] UpdateCollectionRequest req,
        CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var collection = await db.Collections.FirstOrDefaultAsync(
            c => c.Id == id && c.ProjectId == projectId && c.DeletedAt == null, ct);
        if (collection is null) return NotFound();

        collection.Name = req.Name;
        collection.AuthJson = req.Auth is null ? null : JsonSerializer.Serialize(req.Auth, JsonOpts);
        collection.Version++;
        collection.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return ToDto(collection);
    }

    [HttpPost("{id:guid}/move")]
    public async Task<ActionResult<CollectionDto>> Move(
        Guid projectId,
        Guid id,
        [FromBody] MoveCollectionRequest req,
        CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var collection = await db.Collections.FirstOrDefaultAsync(
            c => c.Id == id && c.ProjectId == projectId && c.DeletedAt == null, ct);
        if (collection is null) return NotFound();

        if (req.NewParentId == id)
            return BadRequest(new { error = "cannot_parent_to_self" });

        // Prevent cycle: destination can't be a descendant of the moved folder
        if (req.NewParentId.HasValue)
        {
            var descendants = await GetDescendantIdsAsync(id, projectId, ct);
            if (descendants.Contains(req.NewParentId.Value))
                return BadRequest(new { error = "cannot_move_into_descendant" });
        }

        var oldParentId = collection.ParentId;
        var newParentId = req.NewParentId;

        collection.ParentId = newParentId;
        collection.Version++;
        collection.UpdatedAt = DateTime.UtcNow;

        // Rebalance siblings at new parent, placing this at the requested index
        var newSiblings = await db.Collections
            .Where(c => c.ProjectId == projectId && c.ParentId == newParentId && c.Id != id && c.DeletedAt == null)
            .OrderBy(c => c.SortIndex)
            .ToListAsync(ct);
        var insertAt = Math.Clamp(req.NewSortIndex, 0, newSiblings.Count);
        newSiblings.Insert(insertAt, collection);
        for (var i = 0; i < newSiblings.Count; i++)
            newSiblings[i].SortIndex = i;

        // If moving across parents, close the gap in the old parent
        if (oldParentId != newParentId)
        {
            var oldSiblings = await db.Collections
                .Where(c => c.ProjectId == projectId && c.ParentId == oldParentId && c.Id != id && c.DeletedAt == null)
                .OrderBy(c => c.SortIndex)
                .ToListAsync(ct);
            for (var i = 0; i < oldSiblings.Count; i++)
                oldSiblings[i].SortIndex = i;
        }

        await db.SaveChangesAsync(ct);
        return ToDto(collection);
    }

    private async Task<HashSet<Guid>> GetDescendantIdsAsync(
        Guid rootId,
        Guid projectId,
        CancellationToken ct)
    {
        var result = new HashSet<Guid>();
        var stack = new Stack<Guid>();
        stack.Push(rootId);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            var kids = await db.Collections
                .Where(c => c.ProjectId == projectId && c.ParentId == current && c.DeletedAt == null)
                .Select(c => c.Id)
                .ToListAsync(ct);
            foreach (var k in kids)
                if (result.Add(k))
                    stack.Push(k);
        }
        return result;
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid id, CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var collection = await db.Collections.FirstOrDefaultAsync(
            c => c.Id == id && c.ProjectId == projectId && c.DeletedAt == null, ct);
        if (collection is null) return NotFound();

        collection.DeletedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return NoContent();
    }

    [HttpGet("{id:guid}/variables")]
    public async Task<ActionResult<List<VariableDto>>> ListVariables(
        Guid projectId,
        Guid id,
        CancellationToken ct)
    {
        if (!await HasAccessAsync(projectId, ct)) return Forbid();

        var vars = await db.Variables
            .Where(v => v.Scope == VariableScope.Collection && v.ScopeId == id)
            .Select(v => new VariableDto(
                v.Id, v.Scope, v.ScopeId, v.Key, v.Value, v.IsSecret,
                v.Ciphertext == null ? null : Convert.ToBase64String(v.Ciphertext),
                v.Nonce == null ? null : Convert.ToBase64String(v.Nonce),
                v.KeyId, v.Version))
            .ToListAsync(ct);
        return vars;
    }

    [HttpPost("{id:guid}/variables")]
    public async Task<ActionResult<VariableDto>> UpsertVariable(
        Guid projectId,
        Guid id,
        [FromBody] UpsertVariableRequest req,
        CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var existing = await db.Variables.FirstOrDefaultAsync(
            v => v.Scope == VariableScope.Collection && v.ScopeId == id && v.Key == req.Key,
            ct);

        var now = DateTime.UtcNow;
        if (existing is null)
        {
            existing = new Variable
            {
                Id = Guid.NewGuid(),
                Scope = VariableScope.Collection,
                ScopeId = id,
                Key = req.Key,
                CreatedAt = now,
            };
            db.Variables.Add(existing);
        }

        // IsSecret is a UI flag until E2EE lands; store the plaintext so
        // the variable can actually resolve. Ciphertext path exists for later.
        existing.Value = req.Value;
        existing.IsSecret = req.IsSecret;
        existing.Ciphertext = req.Ciphertext is null ? null : Convert.FromBase64String(req.Ciphertext);
        existing.Nonce = req.Nonce is null ? null : Convert.FromBase64String(req.Nonce);
        existing.KeyId = req.KeyId;
        existing.Version++;
        existing.UpdatedAt = now;

        await db.SaveChangesAsync(ct);

        return new VariableDto(
            existing.Id, existing.Scope, existing.ScopeId, existing.Key,
            existing.Value, existing.IsSecret,
            existing.Ciphertext == null ? null : Convert.ToBase64String(existing.Ciphertext),
            existing.Nonce == null ? null : Convert.ToBase64String(existing.Nonce),
            existing.KeyId, existing.Version);
    }

    [HttpDelete("{id:guid}/variables/{variableId:guid}")]
    public async Task<IActionResult> DeleteVariable(
        Guid projectId,
        Guid id,
        Guid variableId,
        CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var v = await db.Variables.FirstOrDefaultAsync(
            x => x.Id == variableId && x.Scope == VariableScope.Collection && x.ScopeId == id, ct);
        if (v is null) return NotFound();

        db.Variables.Remove(v);
        await db.SaveChangesAsync(ct);
        return NoContent();
    }

    private async Task<Guid?> GetOrgIdAsync(Guid projectId, CancellationToken ct) =>
        await db.Projects
            .Where(p => p.Id == projectId && p.DeletedAt == null)
            .Select(p => (Guid?)p.OrganizationId)
            .FirstOrDefaultAsync(ct);

    /// <summary>
    /// Read access to a project. Phase 2 narrowed this so restricted
    /// Editors only see their granted projects; the previous "any org
    /// member" model is unchanged for everyone else.
    /// </summary>
    private async Task<bool> HasAccessAsync(Guid projectId, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var orgId = await GetOrgIdAsync(projectId, ct);
        return orgId is not null &&
            await guard.CanAccessProjectAsync(orgId.Value, projectId, userId, ct);
    }

    /// <summary>
    /// Write access. Phase 2: same rule as read — restricted Editors
    /// can write to their granted projects, everyone else writes to
    /// anything in the org. Kept as a separate method so a future
    /// "read-only sub-tier" only changes one helper.
    /// </summary>
    private async Task<bool> CanEditAsync(Guid orgId, Guid projectId, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        return await guard.CanAccessProjectAsync(orgId, projectId, userId, ct);
    }

    private static CollectionDto ToDto(Collection c) =>
        new(
            c.Id,
            c.ProjectId,
            c.ParentId,
            c.Name,
            c.SortIndex,
            c.AuthJson is null
                ? null
                : JsonSerializer.Deserialize<AuthConfigDto>(c.AuthJson, JsonOpts),
            c.Version,
            c.CreatedAt,
            c.UpdatedAt);
}
