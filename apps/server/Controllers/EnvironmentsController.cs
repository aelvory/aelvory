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
[Route("api/projects/{projectId:guid}/environments")]
public class EnvironmentsController(
    AelvoryDbContext db,
    ICurrentUserService current,
    IActivityLogger activity,
    IAccessGuard guard) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<List<EnvironmentDto>>> List(Guid projectId, CancellationToken ct)
    {
        if (!await HasAccessAsync(projectId, ct)) return Forbid();

        var envs = await db.Environments
            .Where(e => e.ProjectId == projectId && e.DeletedAt == null)
            .OrderBy(e => e.Name)
            .Select(e => ToDto(e))
            .ToListAsync(ct);
        return envs;
    }

    [HttpPost]
    public async Task<ActionResult<EnvironmentDto>> Create(
        Guid projectId,
        [FromBody] CreateEnvironmentRequest req,
        CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var now = DateTime.UtcNow;
        var env = new ApiEnvironment
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            Name = req.Name,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Environments.Add(env);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(current.RequireUserId(), orgId.Value, "Environment",
            env.Id, "created", new { name = env.Name }, ct);
        return ToDto(env);
    }

    [HttpPut("{id:guid}")]
    public async Task<ActionResult<EnvironmentDto>> Update(
        Guid projectId,
        Guid id,
        [FromBody] UpdateEnvironmentRequest req,
        CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var env = await db.Environments.FirstOrDefaultAsync(
            e => e.Id == id && e.ProjectId == projectId && e.DeletedAt == null, ct);
        if (env is null) return NotFound();

        env.Name = req.Name;
        env.Version++;
        env.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return ToDto(env);
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid id, CancellationToken ct)
    {
        var orgId = await GetOrgIdAsync(projectId, ct);
        if (orgId is null || !await CanEditAsync(orgId.Value, projectId, ct)) return Forbid();

        var env = await db.Environments.FirstOrDefaultAsync(
            e => e.Id == id && e.ProjectId == projectId && e.DeletedAt == null, ct);
        if (env is null) return NotFound();

        env.DeletedAt = DateTime.UtcNow;
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
            .Where(v => v.Scope == VariableScope.Environment && v.ScopeId == id)
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
            v => v.Scope == VariableScope.Environment && v.ScopeId == id && v.Key == req.Key,
            ct);

        var now = DateTime.UtcNow;
        if (existing is null)
        {
            existing = new Variable
            {
                Id = Guid.NewGuid(),
                Scope = VariableScope.Environment,
                ScopeId = id,
                Key = req.Key,
                CreatedAt = now,
            };
            db.Variables.Add(existing);
        }

        // Until E2EE is wired up, IsSecret is a UI-masking flag only.
        // The plaintext value is stored either way, so the variable can still
        // be resolved at request time. When E2EE lands, callers will send
        // ciphertext/nonce/keyId and leave Value null.
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
            x => x.Id == variableId && x.Scope == VariableScope.Environment && x.ScopeId == id, ct);
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

    private async Task<bool> HasAccessAsync(Guid projectId, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var orgId = await GetOrgIdAsync(projectId, ct);
        return orgId is not null &&
            await guard.CanAccessProjectAsync(orgId.Value, projectId, userId, ct);
    }

    private async Task<bool> CanEditAsync(Guid orgId, Guid projectId, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        return await guard.CanAccessProjectAsync(orgId, projectId, userId, ct);
    }

    private static EnvironmentDto ToDto(ApiEnvironment e) =>
        new(e.Id, e.ProjectId, e.Name, e.Version, e.CreatedAt, e.UpdatedAt);
}
