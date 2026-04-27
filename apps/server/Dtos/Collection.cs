namespace Aelvory.Server.Dtos;

public record CollectionDto(
    Guid Id,
    Guid ProjectId,
    Guid? ParentId,
    string Name,
    int SortIndex,
    AuthConfigDto? Auth,
    int Version,
    DateTime CreatedAt,
    DateTime UpdatedAt);

public record CreateCollectionRequest(
    string Name,
    Guid? ParentId,
    int? SortIndex,
    AuthConfigDto? Auth);

public record UpdateCollectionRequest(
    string Name,
    AuthConfigDto? Auth);

public record MoveCollectionRequest(Guid? NewParentId, int NewSortIndex);
