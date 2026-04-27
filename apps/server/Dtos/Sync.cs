namespace Aelvory.Server.Dtos;

/// <summary>
/// Wire shape for sync entries. <c>OrganizationId</c> and
/// <c>ProjectId</c> are populated by the client in push (so the server
/// knows which scope the row belongs to without re-walking the entity
/// hierarchy) and echoed back in pull. <c>ProjectId</c> is null for
/// org-level entities (Organization, Member, ProjectMember).
/// </summary>
public record SyncEntryDto(
    Guid OrganizationId,
    Guid? ProjectId,
    string EntityType,
    Guid EntityId,
    string PayloadFormat,
    byte[] Payload,
    string? CryptoHeader,
    DateTime UpdatedAt,
    DateTime? DeletedAt,
    long Seq);

public record SyncPushRequest(List<SyncEntryDto> Entries);

public record SyncPushResponse(
    int Accepted,
    int Rejected,
    long ServerCursor,
    List<SyncConflictDto> Conflicts);

public record SyncConflictDto(
    string EntityType,
    Guid EntityId,
    long ServerSeq,
    DateTime ServerUpdatedAt);

public record SyncPullResponse(
    List<SyncEntryDto> Entries,
    long ServerCursor);
