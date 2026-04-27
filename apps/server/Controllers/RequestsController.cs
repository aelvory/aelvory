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
[Route("api/collections/{collectionId:guid}/requests")]
public class RequestsController(
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
    public async Task<ActionResult<List<ApiRequestDto>>> List(Guid collectionId, CancellationToken ct)
    {
        if (!await HasAccessAsync(collectionId, ct)) return Forbid();

        var requests = await db.Requests
            .Where(r => r.CollectionId == collectionId && r.DeletedAt == null)
            .OrderBy(r => r.SortIndex)
            .ToListAsync(ct);
        return requests.Select(ToDto).ToList();
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<ApiRequestDto>> Get(
        Guid collectionId,
        Guid id,
        CancellationToken ct)
    {
        if (!await HasAccessAsync(collectionId, ct)) return Forbid();

        var r = await db.Requests.FirstOrDefaultAsync(
            x => x.Id == id && x.CollectionId == collectionId && x.DeletedAt == null, ct);
        return r is null ? NotFound() : ToDto(r);
    }

    [HttpPost]
    public async Task<ActionResult<ApiRequestDto>> Create(
        Guid collectionId,
        [FromBody] CreateRequestRequest req,
        CancellationToken ct)
    {
        var scope = await GetScopeAsync(collectionId, ct);
        if (scope is null || !await CanEditAsync(scope.Value.OrgId, scope.Value.ProjectId, ct)) return Forbid();
        Guid? orgId = scope.Value.OrgId;

        var now = DateTime.UtcNow;
        var sortIndex = req.SortIndex ??
            await db.Requests.Where(r => r.CollectionId == collectionId).CountAsync(ct);

        var request = new ApiRequest
        {
            Id = Guid.NewGuid(),
            CollectionId = collectionId,
            Name = req.Name,
            Kind = req.Kind,
            Method = req.Method,
            Url = req.Url,
            HeadersJson = JsonSerializer.Serialize(req.Headers ?? [], JsonOpts),
            BodyJson = req.Body is null ? null : JsonSerializer.Serialize(req.Body, JsonOpts),
            AuthJson = req.Auth is null ? null : JsonSerializer.Serialize(req.Auth, JsonOpts),
            SortIndex = sortIndex,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Requests.Add(request);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(current.RequireUserId(), orgId.Value, "Request",
            request.Id, "created", new { name = request.Name, method = request.Method }, ct);
        return CreatedAtAction(nameof(Get), new { collectionId, id = request.Id }, ToDto(request));
    }

    [HttpPut("{id:guid}")]
    public async Task<ActionResult<ApiRequestDto>> Update(
        Guid collectionId,
        Guid id,
        [FromBody] UpdateRequestRequest req,
        CancellationToken ct)
    {
        var scope = await GetScopeAsync(collectionId, ct);
        if (scope is null || !await CanEditAsync(scope.Value.OrgId, scope.Value.ProjectId, ct)) return Forbid();
        Guid? orgId = scope.Value.OrgId;

        var request = await db.Requests.FirstOrDefaultAsync(
            r => r.Id == id && r.CollectionId == collectionId && r.DeletedAt == null, ct);
        if (request is null) return NotFound();

        request.Name = req.Name;
        request.Method = req.Method;
        request.Url = req.Url;
        request.HeadersJson = JsonSerializer.Serialize(req.Headers, JsonOpts);
        request.BodyJson = req.Body is null ? null : JsonSerializer.Serialize(req.Body, JsonOpts);
        request.AuthJson = req.Auth is null ? null : JsonSerializer.Serialize(req.Auth, JsonOpts);
        request.Version++;
        request.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return ToDto(request);
    }

    [HttpPost("{id:guid}/move")]
    public async Task<ActionResult<ApiRequestDto>> Move(
        Guid collectionId,
        Guid id,
        [FromBody] MoveRequestRequest req,
        CancellationToken ct)
    {
        var scope = await GetScopeAsync(collectionId, ct);
        if (scope is null || !await CanEditAsync(scope.Value.OrgId, scope.Value.ProjectId, ct)) return Forbid();
        Guid? orgId = scope.Value.OrgId;

        var request = await db.Requests.FirstOrDefaultAsync(
            r => r.Id == id && r.CollectionId == collectionId && r.DeletedAt == null, ct);
        if (request is null) return NotFound();

        var newCollection = await db.Collections.FirstOrDefaultAsync(
            c => c.Id == req.NewCollectionId && c.DeletedAt == null, ct);
        if (newCollection is null)
            return BadRequest(new { error = "new_collection_not_found" });

        // Ensure the user can edit the destination collection (same org
        // tree, AND — for restricted Editors — they have access to the
        // destination's project as well).
        var newOrgId = await db.Projects
            .Where(p => p.Id == newCollection.ProjectId && p.DeletedAt == null)
            .Select(p => (Guid?)p.OrganizationId)
            .FirstOrDefaultAsync(ct);
        if (newOrgId is null ||
            !await CanEditAsync(newOrgId.Value, newCollection.ProjectId, ct))
        {
            return Forbid();
        }

        var oldCollectionId = request.CollectionId;
        request.CollectionId = req.NewCollectionId;
        request.Version++;
        request.UpdatedAt = DateTime.UtcNow;

        var newSiblings = await db.Requests
            .Where(r => r.CollectionId == req.NewCollectionId && r.Id != id && r.DeletedAt == null)
            .OrderBy(r => r.SortIndex)
            .ToListAsync(ct);
        var insertAt = Math.Clamp(req.NewSortIndex, 0, newSiblings.Count);
        newSiblings.Insert(insertAt, request);
        for (var i = 0; i < newSiblings.Count; i++)
            newSiblings[i].SortIndex = i;

        if (oldCollectionId != req.NewCollectionId)
        {
            var oldSiblings = await db.Requests
                .Where(r => r.CollectionId == oldCollectionId && r.Id != id && r.DeletedAt == null)
                .OrderBy(r => r.SortIndex)
                .ToListAsync(ct);
            for (var i = 0; i < oldSiblings.Count; i++)
                oldSiblings[i].SortIndex = i;
        }

        await db.SaveChangesAsync(ct);
        return ToDto(request);
    }

    [HttpPost("{id:guid}/duplicate")]
    public async Task<ActionResult<ApiRequestDto>> Duplicate(
        Guid collectionId,
        Guid id,
        CancellationToken ct)
    {
        var scope = await GetScopeAsync(collectionId, ct);
        if (scope is null || !await CanEditAsync(scope.Value.OrgId, scope.Value.ProjectId, ct)) return Forbid();
        Guid? orgId = scope.Value.OrgId;

        var src = await db.Requests.FirstOrDefaultAsync(
            r => r.Id == id && r.CollectionId == collectionId && r.DeletedAt == null, ct);
        if (src is null) return NotFound();

        var now = DateTime.UtcNow;
        var copy = new ApiRequest
        {
            Id = Guid.NewGuid(),
            CollectionId = src.CollectionId,
            Name = $"{src.Name} (copy)",
            Kind = src.Kind,
            Method = src.Method,
            Url = src.Url,
            HeadersJson = src.HeadersJson,
            BodyJson = src.BodyJson,
            AuthJson = src.AuthJson,
            SortIndex = src.SortIndex + 1,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Requests.Add(copy);
        await db.SaveChangesAsync(ct);
        return ToDto(copy);
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(
        Guid collectionId,
        Guid id,
        CancellationToken ct)
    {
        var scope = await GetScopeAsync(collectionId, ct);
        if (scope is null || !await CanEditAsync(scope.Value.OrgId, scope.Value.ProjectId, ct)) return Forbid();
        Guid? orgId = scope.Value.OrgId;

        var request = await db.Requests.FirstOrDefaultAsync(
            r => r.Id == id && r.CollectionId == collectionId && r.DeletedAt == null, ct);
        if (request is null) return NotFound();

        request.DeletedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return NoContent();
    }

    [HttpGet("{id:guid}/scripts")]
    public async Task<ActionResult<List<ScriptDto>>> ListScripts(
        Guid collectionId,
        Guid id,
        CancellationToken ct)
    {
        if (!await HasAccessAsync(collectionId, ct)) return Forbid();

        var scripts = await db.Scripts
            .Where(s => s.RequestId == id)
            .Select(s => new ScriptDto(s.Id, s.RequestId, s.Phase, s.Source))
            .ToListAsync(ct);
        return scripts;
    }

    [HttpPut("{id:guid}/scripts")]
    public async Task<ActionResult<ScriptDto>> UpsertScript(
        Guid collectionId,
        Guid id,
        [FromBody] UpsertScriptRequest req,
        CancellationToken ct)
    {
        var scope = await GetScopeAsync(collectionId, ct);
        if (scope is null || !await CanEditAsync(scope.Value.OrgId, scope.Value.ProjectId, ct)) return Forbid();
        Guid? orgId = scope.Value.OrgId;

        var script = await db.Scripts.FirstOrDefaultAsync(
            s => s.RequestId == id && s.Phase == req.Phase, ct);

        var now = DateTime.UtcNow;
        if (script is null)
        {
            script = new Script
            {
                Id = Guid.NewGuid(),
                RequestId = id,
                Phase = req.Phase,
                Source = req.Source,
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.Scripts.Add(script);
        }
        else
        {
            script.Source = req.Source;
            script.Version++;
            script.UpdatedAt = now;
        }

        await db.SaveChangesAsync(ct);
        return new ScriptDto(script.Id, script.RequestId, script.Phase, script.Source);
    }

    /// <summary>
    /// Resolve the (org, project) scope of a collection in one query.
    /// Returns null when the collection is missing or soft-deleted.
    /// </summary>
    private async Task<(Guid OrgId, Guid ProjectId)?> GetScopeAsync(
        Guid collectionId, CancellationToken ct)
    {
        var row = await db.Collections
            .Where(c => c.Id == collectionId && c.DeletedAt == null)
            .Select(c => new { c.ProjectId, OrgId = c.Project.OrganizationId })
            .FirstOrDefaultAsync(ct);
        return row is null ? null : (row.OrgId, row.ProjectId);
    }

    private async Task<Guid?> GetOrgIdAsync(Guid collectionId, CancellationToken ct)
    {
        var s = await GetScopeAsync(collectionId, ct);
        return s?.OrgId;
    }

    private async Task<bool> HasAccessAsync(Guid collectionId, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var s = await GetScopeAsync(collectionId, ct);
        return s is not null &&
            await guard.CanAccessProjectAsync(s.Value.OrgId, s.Value.ProjectId, userId, ct);
    }

    private async Task<bool> CanEditAsync(Guid orgId, Guid projectId, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        return await guard.CanAccessProjectAsync(orgId, projectId, userId, ct);
    }

    private static ApiRequestDto ToDto(ApiRequest r) =>
        new(
            r.Id,
            r.CollectionId,
            r.Name,
            r.Kind,
            r.Method,
            r.Url,
            JsonSerializer.Deserialize<List<HeaderDto>>(r.HeadersJson, JsonOpts) ?? [],
            r.BodyJson is null ? null : JsonSerializer.Deserialize<RequestBodyDto>(r.BodyJson, JsonOpts),
            r.AuthJson is null ? null : JsonSerializer.Deserialize<AuthConfigDto>(r.AuthJson, JsonOpts),
            r.SortIndex,
            r.Version,
            r.CreatedAt,
            r.UpdatedAt);
}
