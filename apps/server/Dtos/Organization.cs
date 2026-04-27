using Aelvory.Server.Entities;

namespace Aelvory.Server.Dtos;

public record OrganizationDto(
    Guid Id,
    string Name,
    OrganizationKind Kind,
    Guid OwnerId,
    int Version,
    DateTime CreatedAt,
    DateTime UpdatedAt);

public record CreateOrganizationRequest(string Name);

public record UpdateOrganizationRequest(string Name);

/// <summary>
/// Per-org membership row. <see cref="Restricted"/> mirrors the column
/// added in Phase 1 — when true, this user only sees projects they
/// have an explicit ProjectMember grant for. Owners/admins ignore the
/// flag (they always see everything).
/// </summary>
public record MemberDto(
    Guid Id,
    Guid UserId,
    string Email,
    string DisplayName,
    MemberRole Role,
    bool Restricted,
    string? WrappedDek);

public record InviteMemberRequest(
    string Email,
    MemberRole Role,
    bool Restricted,
    string? WrappedDek);

public record UpdateMemberRequest(MemberRole Role, bool Restricted);

/// <summary>
/// Per-project access grant. Sent only to a user who is a restricted
/// org Member; without a row here, that user can't see the project.
/// </summary>
public record ProjectMemberDto(
    Guid Id,
    Guid ProjectId,
    Guid UserId,
    string Email,
    string DisplayName,
    Guid GrantedBy,
    DateTime GrantedAt);

public record GrantProjectAccessRequest(Guid UserId);
