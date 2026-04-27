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
[Route("api/organizations")]
public class OrganizationsController(
    AelvoryDbContext db,
    ICurrentUserService current,
    IActivityLogger activity,
    ISyncEntityBridge syncBridge) : ControllerBase
{
    /// <summary>
    /// Wire payload for an organization SyncEntry. Field names match
    /// <c>LOrganization</c> in the desktop's local schema.
    /// </summary>
    private static object OrgPayload(Organization o) => new
    {
        id = o.Id,
        name = o.Name,
        kind = o.Kind, // serialized as camelCase string by JsonStringEnumConverter
        ownerId = o.OwnerId,
        version = o.Version,
        createdAt = o.CreatedAt,
        updatedAt = o.UpdatedAt,
        deletedAt = o.DeletedAt,
    };

    /// <summary>
    /// Wire payload for a member SyncEntry. Matches <c>LMember</c>.
    /// Members don't have a <c>deleted_at</c> column locally, so a
    /// tombstone (<c>DeletedAt</c> non-null on the envelope) is
    /// applied as a hard <c>DELETE</c> by the desktop's
    /// applyIncoming.
    /// </summary>
    private static object MemberPayload(Member m) => new
    {
        id = m.Id,
        organizationId = m.OrganizationId,
        userId = m.UserId,
        role = m.Role, // camelCase string
        restricted = m.Restricted,
        wrappedDek = m.WrappedDek is null ? null : Convert.ToBase64String(m.WrappedDek),
        createdAt = m.CreatedAt,
    };
    [HttpGet]
    public async Task<ActionResult<List<OrganizationDto>>> List(CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var orgs = await db.Members
            .Where(m => m.UserId == userId && m.Organization.DeletedAt == null)
            .Select(m => m.Organization)
            .ToListAsync(ct);
        return orgs.Select(ToDto).ToList();
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<OrganizationDto>> Get(Guid id, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var org = await db.Organizations.FirstOrDefaultAsync(
            o => o.Id == id && o.DeletedAt == null && o.Members.Any(m => m.UserId == userId),
            ct);
        return org is null ? NotFound() : ToDto(org);
    }

    [HttpPost]
    public async Task<ActionResult<OrganizationDto>> Create(
        [FromBody] CreateOrganizationRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var now = DateTime.UtcNow;
        var org = new Organization
        {
            Id = Guid.NewGuid(),
            Name = req.Name,
            Kind = OrganizationKind.Team,
            OwnerId = userId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Organizations.Add(org);
        var owner = new Member
        {
            Id = Guid.NewGuid(),
            OrganizationId = org.Id,
            UserId = userId,
            Role = MemberRole.Owner,
            // Owner is implicitly unrestricted regardless, but we set
            // it explicitly so the row matches what an admin sees in
            // the members list.
            Restricted = false,
            CreatedAt = now,
        };
        db.Members.Add(owner);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, org.Id, "Organization", org.Id, "created",
            new { name = org.Name }, ct);
        // Publish org + the owner's member row. Both flow to any
        // desktops the user is signed in to (typically just the one
        // that's open at the moment; in the rare two-device admin-UI
        // session case, the other desktop sees the new org appear
        // live).
        await syncBridge.PublishAsync(
            orgId: org.Id, projectId: null,
            entityType: "organizations", entityId: org.Id,
            payload: OrgPayload(org), updatedAt: org.UpdatedAt,
            deletedAt: null, userId: userId,
            excludeConnectionId: null, ct: ct);
        await syncBridge.PublishAsync(
            orgId: org.Id, projectId: null,
            entityType: "members", entityId: owner.Id,
            payload: MemberPayload(owner), updatedAt: owner.CreatedAt,
            deletedAt: null, userId: userId,
            excludeConnectionId: null, ct: ct);
        return CreatedAtAction(nameof(Get), new { id = org.Id }, ToDto(org));
    }

    [HttpPut("{id:guid}")]
    public async Task<ActionResult<OrganizationDto>> Update(
        Guid id,
        [FromBody] UpdateOrganizationRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var org = await db.Organizations.FirstOrDefaultAsync(
            o => o.Id == id && o.DeletedAt == null &&
                 o.Members.Any(m => m.UserId == userId &&
                     (m.Role == MemberRole.Owner || m.Role == MemberRole.Admin)),
            ct);
        if (org is null) return NotFound();

        org.Name = req.Name;
        org.Version++;
        org.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, org.Id, "Organization", org.Id, "updated",
            new { name = org.Name }, ct);
        await syncBridge.PublishAsync(
            orgId: org.Id, projectId: null,
            entityType: "organizations", entityId: org.Id,
            payload: OrgPayload(org), updatedAt: org.UpdatedAt,
            deletedAt: null, userId: userId,
            excludeConnectionId: null, ct: ct);
        return ToDto(org);
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var org = await db.Organizations.FirstOrDefaultAsync(
            o => o.Id == id && o.DeletedAt == null && o.OwnerId == userId &&
                 o.Kind == OrganizationKind.Team,
            ct);
        if (org is null) return NotFound();

        org.DeletedAt = DateTime.UtcNow;
        org.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, org.Id, "Organization", org.Id, "deleted", null, ct);
        await syncBridge.PublishAsync(
            orgId: org.Id, projectId: null,
            entityType: "organizations", entityId: org.Id,
            payload: OrgPayload(org), updatedAt: org.UpdatedAt,
            deletedAt: org.DeletedAt, userId: userId,
            excludeConnectionId: null, ct: ct);
        return NoContent();
    }

    [HttpGet("{id:guid}/members")]
    public async Task<ActionResult<List<MemberDto>>> ListMembers(Guid id, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        // Return NotFound (not Forbid) for non-members. Mirrors what
        // Get() does for the same condition — both endpoints should
        // behave identically from a probing attacker's perspective so
        // org id existence isn't leaked. Org ids are random Guids so
        // the practical information leak was minor, but the
        // inconsistency between Get and ListMembers gave a clear
        // "this org exists but I can't see it" oracle.
        if (!await IsMemberAsync(id, userId, ct)) return NotFound();

        var members = await db.Members
            .Where(m => m.OrganizationId == id)
            .Select(m => new MemberDto(
                m.Id, m.UserId, m.User.Email, m.User.DisplayName, m.Role,
                m.Restricted,
                m.WrappedDek == null ? null : Convert.ToBase64String(m.WrappedDek)))
            .ToListAsync(ct);
        return members;
    }

    [HttpPost("{id:guid}/members")]
    public async Task<ActionResult<MemberDto>> Invite(
        Guid id,
        [FromBody] InviteMemberRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        if (!await IsAdminAsync(id, userId, ct)) return Forbid();

        var invitee = await db.Users.SingleOrDefaultAsync(u => u.Email == req.Email, ct);
        if (invitee is null) return NotFound(new { error = "user_not_found" });

        if (await db.Members.AnyAsync(m => m.OrganizationId == id && m.UserId == invitee.Id, ct))
            return Conflict(new { error = "already_member" });

        // Phase 1's auto-promotion: Owner/Admin can never be restricted
        // (the flag is meaningful only for Editor). Silently ignore the
        // request's value if it conflicts with the role.
        var restricted = req.Role == MemberRole.Editor && req.Restricted;

        var member = new Member
        {
            Id = Guid.NewGuid(),
            OrganizationId = id,
            UserId = invitee.Id,
            Role = req.Role,
            Restricted = restricted,
            WrappedDek = string.IsNullOrEmpty(req.WrappedDek)
                ? null
                : Convert.FromBase64String(req.WrappedDek),
            CreatedAt = DateTime.UtcNow,
        };
        db.Members.Add(member);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, id, "Member", member.Id, "invited",
            new { email = invitee.Email, role = req.Role.ToString(), restricted }, ct);
        await syncBridge.PublishAsync(
            orgId: id, projectId: null,
            entityType: "members", entityId: member.Id,
            payload: MemberPayload(member), updatedAt: member.CreatedAt,
            deletedAt: null, userId: userId,
            excludeConnectionId: null, ct: ct);

        return new MemberDto(member.Id, invitee.Id, invitee.Email, invitee.DisplayName,
            member.Role, member.Restricted, req.WrappedDek);
    }

    [HttpPut("{id:guid}/members/{memberId:guid}")]
    public async Task<IActionResult> UpdateMember(
        Guid id,
        Guid memberId,
        [FromBody] UpdateMemberRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        if (!await IsAdminAsync(id, userId, ct)) return Forbid();

        var member = await db.Members.FirstOrDefaultAsync(
            m => m.Id == memberId && m.OrganizationId == id, ct);
        if (member is null) return NotFound();

        // Owners stay owners until ownership is transferred; admins
        // can downgrade them but only an owner can. We don't enforce
        // that nuance here — the simpler "admin can change anything
        // below them" model. If we ever need real RBAC, this is the
        // place to tighten.
        member.Role = req.Role;
        member.Restricted = req.Role == MemberRole.Editor && req.Restricted;
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, id, "Member", memberId, "role_changed",
            new { role = req.Role.ToString(), restricted = member.Restricted }, ct);
        // Members don't have an UpdatedAt column; use UtcNow as the
        // monotonic clock for last-writer-wins semantics on the wire.
        await syncBridge.PublishAsync(
            orgId: id, projectId: null,
            entityType: "members", entityId: member.Id,
            payload: MemberPayload(member), updatedAt: DateTime.UtcNow,
            deletedAt: null, userId: userId,
            excludeConnectionId: null, ct: ct);
        return NoContent();
    }

    [HttpDelete("{id:guid}/members/{memberId:guid}")]
    public async Task<IActionResult> RemoveMember(Guid id, Guid memberId, CancellationToken ct)
    {
        var userId = current.RequireUserId();
        if (!await IsAdminAsync(id, userId, ct)) return Forbid();

        var member = await db.Members.FirstOrDefaultAsync(
            m => m.Id == memberId && m.OrganizationId == id, ct);
        if (member is null) return NotFound();

        // Capture the snapshot BEFORE Remove() — we still need to emit
        // a tombstone payload after the row is gone from EF tracking.
        var snapshot = MemberPayload(member);
        db.Members.Remove(member);
        await db.SaveChangesAsync(ct);
        await activity.LogAsync(userId, id, "Member", memberId, "removed", null, ct);
        // Tombstone — desktop's `members` table has no `deleted_at`
        // column, so applyIncoming hard-DELETEs the local row when
        // it sees a non-null DeletedAt on the envelope.
        var now = DateTime.UtcNow;
        await syncBridge.PublishAsync(
            orgId: id, projectId: null,
            entityType: "members", entityId: memberId,
            payload: snapshot, updatedAt: now,
            deletedAt: now, userId: userId,
            excludeConnectionId: null, ct: ct);
        return NoContent();
    }

    private Task<bool> IsMemberAsync(Guid orgId, Guid userId, CancellationToken ct) =>
        db.Members.AnyAsync(m => m.OrganizationId == orgId && m.UserId == userId, ct);

    private Task<bool> IsAdminAsync(Guid orgId, Guid userId, CancellationToken ct) =>
        db.Members.AnyAsync(m => m.OrganizationId == orgId && m.UserId == userId &&
                                  (m.Role == MemberRole.Owner || m.Role == MemberRole.Admin), ct);

    private static OrganizationDto ToDto(Organization o) =>
        new(o.Id, o.Name, o.Kind, o.OwnerId, o.Version, o.CreatedAt, o.UpdatedAt);
}
